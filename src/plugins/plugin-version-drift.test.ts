import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginUpdateSelection } from "../cli/plugins-update-selection.js";
import type { PluginInstallRecord as InstallRecord } from "../config/types.plugins.js";
import {
  fetchClawHubPackageDetail,
  resolveLatestVersionFromPackage,
} from "../infra/clawhub-packages.js";
import { fetchNpmPackageTargetStatus } from "../infra/update-check-package-target.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  detectPluginVersionDrift as detectDrift,
  resolvePluginVersionDriftRegistryLag as registryLag,
  resolvePluginVersionDriftUpdateCommand as repairCommand,
  resolvePluginVersionDriftTargets as resolveTargets,
} from "./plugin-version-drift.js";
import { resolveClawHubUpdateSpecs } from "./update-source.js";

vi.mock("../infra/update-check-package-target.js", () => ({
  fetchNpmPackageTargetStatus: vi.fn(),
}));
vi.mock("../infra/clawhub-packages.js", () => ({
  fetchClawHubPackageDetail: vi.fn(),
  resolveLatestVersionFromPackage: vi.fn(),
}));

const hubPackage = "@openclaw/whatsapp";
const hubSpec = (tag = "") => `clawhub:${hubPackage}${tag ? `@${tag}` : ""}`;

function npmRecord(version: string, patch: Partial<InstallRecord> = {}): InstallRecord {
  const resolvedName = patch.resolvedName ?? "@openclaw/whatsapp";
  return {
    source: "npm",
    spec: `${resolvedName}@latest`,
    resolvedName,
    resolvedVersion: version,
    ...patch,
  };
}

function clawhubRecord(version: string, patch: Partial<InstallRecord> = {}): InstallRecord {
  return {
    source: "clawhub",
    spec: hubSpec(),
    clawhubPackage: hubPackage,
    resolvedVersion: version,
    ...patch,
  };
}

function firstDrift(report: ReturnType<typeof detectDrift>) {
  return expectDefined(report.drifts[0], "detected plugin drift");
}

function expectRegistryLookup(name = "@openclaw/whatsapp") {
  expect(fetchClawHubPackageDetail).toHaveBeenCalledWith({ name, baseUrl: "https://clawhub.ai" });
}

function hubTarget<T extends object>(fields: T) {
  return { packageName: hubPackage, requestedTarget: "2026.9.4", ...fields };
}

function expectNoRepair(entry: ReturnType<typeof firstDrift>) {
  expect(entry.targetResolution?.status).toBe("unresolved");
  expect(repairCommand(entry)).toBeUndefined();
  expect(fetchClawHubPackageDetail).not.toHaveBeenCalled();
}

it("reports only active, unpinned cohort mismatches in plugin order", () => {
  const report = detectDrift({
    gatewayVersion: "2026.5.4-1",
    installRecords: {
      whatsapp: npmRecord("2026.5.4"),
      discord: npmRecord("2026.5.4-1", { resolvedName: "@openclaw/discord" }),
      slack: npmRecord("2026.5.3", {
        resolvedName: "@openclaw/slack",
        resolvedVersion: undefined,
        version: "2026.5.3",
      }),
      matrix: npmRecord("2026.5.3", { resolvedName: "@openclaw/matrix" }),
      telegram: npmRecord("2026.5.3", { resolvedName: "@openclaw/telegram" }),
      brave: { source: "npm", spec: "@openclaw/brave-plugin@latest" },
      "wecom-openclaw-plugin": npmRecord("2026.5.6", {
        resolvedName: "@wecom/wecom-openclaw-plugin",
        spec: "@wecom/wecom-openclaw-plugin@2026.5.6",
      }),
    },
    config: { plugins: { entries: { telegram: { enabled: false }, slack: { enabled: true } } } },
  });
  expect(report.drifts).toEqual([
    expect.objectContaining({ pluginId: "matrix", installedVersion: "2026.5.3" }),
    expect.objectContaining({ pluginId: "slack", installedVersion: "2026.5.3" }),
  ]);
});
describe("resolvePluginVersionDriftTargets", () => {
  beforeEach(() => vi.mocked(fetchNpmPackageTargetStatus).mockReset());

  function driftReport(
    gatewayVersion = "2026.7.1-2",
    spec = "@openclaw/brave-plugin@2026.7.1-beta.2",
  ) {
    return detectDrift({
      gatewayVersion,
      installRecords: {
        brave: npmRecord("2026.7.1-beta.2", { resolvedName: "@openclaw/brave-plugin", spec }),
      },
    });
  }

  it.each([
    { version: "2026.7.1", command: "openclaw plugins update @openclaw/brave-plugin@2026.7.1" },
    { version: null, error: "HTTP 404", command: undefined },
    { version: "2026.7.1-2", command: undefined },
  ])("repairs confirmed npm cohorts: $version", async ({ command, ...result }) => {
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({ nodeEngine: null, ...result });
    const entry = firstDrift(await resolveTargets(driftReport()));
    expect(fetchNpmPackageTargetStatus).toHaveBeenCalledWith({
      packageName: "@openclaw/brave-plugin",
      target: "2026.7.1",
    });
    if (!command) {
      expect(entry.targetResolution).toMatchObject({
        status: "unresolved",
        packageName: "@openclaw/brave-plugin",
        requestedTarget: "2026.7.1",
        error: expect.stringContaining(result.error ?? JSON.stringify(result.version)),
      });
    }
    expect(repairCommand(entry)).toBe(command);
  });

  it("does not query npm for non-release cohorts or floating installs", async () => {
    const invalid = await resolveTargets(driftReport("unknown"));
    expect(repairCommand(firstDrift(invalid))).toBeUndefined();
    const floating = await resolveTargets(driftReport("2026.7.1", "@openclaw/brave-plugin@latest"));
    expect(repairCommand(firstDrift(floating))).toBe("openclaw plugins update brave");
    expect(fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
  });
});

describe("resolvePluginVersionDriftTargets for ClawHub installs", () => {
  beforeEach(() => {
    vi.mocked(fetchClawHubPackageDetail).mockReset();
    vi.mocked(resolveLatestVersionFromPackage).mockReset();
    vi.mocked(resolveLatestVersionFromPackage).mockReturnValue("2026.9.3");
    vi.mocked(fetchClawHubPackageDetail).mockResolvedValue(
      {} as Awaited<ReturnType<typeof fetchClawHubPackageDetail>>,
    );
  });

  type HubOptions = Partial<InstallRecord> &
    Partial<Pick<Parameters<typeof detectDrift>[0], "gatewayVersion" | "config">> & {
      pluginId?: string;
    };
  function hubReport(installedVersion = "2026.9.3", options: HubOptions = {}) {
    const { gatewayVersion = "2026.9.4", config, pluginId = "whatsapp", ...overrides } = options;
    return detectDrift({
      gatewayVersion,
      installRecords: { [pluginId]: clawhubRecord(installedVersion, overrides) },
      config,
    });
  }

  async function hubEntry(...args: Parameters<typeof hubReport>) {
    return firstDrift(await resolveTargets(hubReport(...args)));
  }

  it.each([
    {
      installed: "2026.9.3",
      latest: "2026.9.3",
      resolution: hubTarget({ status: "registry-current", version: "2026.9.3" }),
      lag: { registryVersion: "2026.9.3", expectedVersion: "2026.9.4" },
    },
    {
      installed: "2026.9.3-2",
      latest: "2026.9.3-1",
      resolution: expect.objectContaining({
        status: "unresolved",
        error: expect.stringContaining("older than installed"),
      }),
    },
    {
      installed: "2026.9.3+hotfix.1",
      latest: "2026.9.3+hotfix.2",
      resolution: expect.objectContaining({ status: "resolved", version: "2026.9.3+hotfix.2" }),
      command: "openclaw plugins update whatsapp",
    },
  ])("ClawHub $installed -> $latest", async ({ installed, latest, resolution, lag, command }) => {
    vi.mocked(resolveLatestVersionFromPackage).mockReturnValue(latest);
    const entry = await hubEntry(installed);
    expect({
      resolution: entry.targetResolution,
      lag: registryLag(entry),
      command: repairCommand(entry),
    }).toEqual({ resolution, lag, command });
    expectRegistryLookup();
  });

  it.each([
    { spec: "clawhub:@openclaw/slack", clawhubPackage: "@openclaw/slack" },
    { spec: "clawhub:@openclaw/slack", clawhubPackage: undefined },
    { spec: undefined, clawhubPackage: "@openclaw/slack" },
  ])("resolves recorded ClawHub identities: %j", async (identity) => {
    const entry = await hubEntry("2026.9.3", {
      pluginId: "slack",
      ...identity,
      clawhubChannel: "official",
      clawhubUrl: "https://clawhub.ai",
    });
    expectRegistryLookup("@openclaw/slack");
    expect(entry.targetResolution).toMatchObject({
      status: "registry-current",
      packageName: "@openclaw/slack",
      version: "2026.9.3",
    });
  });

  it.each<Partial<InstallRecord>>([
    { clawhubUrl: "https://registry.example.test" },
    { clawhubChannel: "community" },
    { resolvedName: "@vendor/slack" },
    { clawhubPackage: "@vendor/slack" },
    { spec: undefined, clawhubPackage: undefined, resolvedSpec: "clawhub:@openclaw/slack" },
  ])("rejects untrusted ClawHub identities: %j", async (overrides) => {
    const report = await resolveTargets(
      hubReport("2026.9.3", {
        pluginId: "slack",
        spec: "clawhub:@openclaw/slack",
        clawhubPackage: "@openclaw/slack",
        clawhubChannel: "official",
        clawhubUrl: "https://clawhub.ai",
        ...overrides,
      }),
    );
    expect(report.drifts).toEqual([]);
    expect(fetchClawHubPackageDetail).not.toHaveBeenCalled();
  });

  it("prefers the recorded registry to the environment", async () => {
    await withEnvAsync({ OPENCLAW_CLAWHUB_URL: "https://alternate.example.test" }, async () => {
      const entry = await hubEntry("2026.9.3", {
        clawhubUrl: "https://clawhub.ai",
        clawhubChannel: "official",
      });
      expectRegistryLookup();
      expect(entry.targetResolution?.status).toBe("registry-current");
    });
  });

  it("prescribes a stale-pin repair accepted by the current selector and update owner", async () => {
    const installRecords: Record<string, InstallRecord> = {
      whatsapp: clawhubRecord("2026.9.2", { spec: hubSpec("2026.9.2") }),
    };
    const report = await resolveTargets(
      detectDrift({
        gatewayVersion: "2026.9.4",
        config: { update: { channel: "stable" } },
        installRecords,
      }),
    );
    expectRegistryLookup();
    const entry = firstDrift(report);
    expect(entry.targetResolution).toEqual(hubTarget({ status: "resolved", version: "2026.9.3" }));
    const command = repairCommand(entry);
    expect(command).toBe("openclaw plugins update whatsapp");
    const rawId = expectDefined(command, "repair command").replace("openclaw plugins update ", "");
    const selectorInput = {
      installs: installRecords,
      rawIds: [rawId, "whatsapp-alias"],
      installOwnerByPluginId: new Map([["whatsapp-alias", "whatsapp"]]),
    };
    const selection = resolvePluginUpdateSelection(selectorInput);
    expect(selection).toEqual({ pluginIds: ["whatsapp"] });
    const selectedId = expectDefined(selection.pluginIds[0], "selected install owner");
    const record = expectDefined(installRecords[selectedId], "selected install record");
    expect(
      resolvePluginUpdateSelection({
        installs: { whatsapp: record },
        rawIds: ["whatsapp-alias"],
        installOwnerByPluginId: new Map([["whatsapp-alias", "whatsapp"]]),
        rejectedPluginIds: new Map([["whatsapp-alias", "fixture ownership rejection"]]),
      }),
    ).toEqual({ pluginIds: [], error: "fixture ownership rejection" });
    expect(
      resolveClawHubUpdateSpecs({
        record,
        officialSpec: entry.clawhubOfficialSpec,
        updateChannel: entry.clawhubUpdateChannel,
        officialPackageName: entry.clawhubPackage,
        coreVersion: entry.gatewayVersion,
      }).installSpec,
    ).toBe("clawhub:@openclaw/whatsapp");
    // Diagnostic guidance cannot bypass current owner/alias admission.
    for (const rejectedId of ["whatsapp", "whatsapp-alias"]) {
      expect(
        resolvePluginUpdateSelection({
          ...selectorInput,
          rejectedPluginIds: new Map([[rejectedId, "fixture ownership rejection"]]),
        }),
      ).toEqual({ pluginIds: [], error: "fixture ownership rejection" });
    }
  });

  it.each<Parameters<typeof hubReport>>([
    ["2026.9.5", { spec: hubSpec("2026.9.5"), config: { update: { channel: "stable" } } }],
    ["2026.9.3", { spec: hubSpec("beta"), config: { update: { channel: "stable" } } }],
    ["2026.9.3", { spec: hubSpec(), config: { update: { channel: "beta" } } }],
    ["2026.9.3", { spec: hubSpec("latest"), config: { update: { channel: "extended-stable" } } }],
    ["2026.9.3", { gatewayVersion: "2026.9.4-beta.1" }],
  ])("withholds repair for selected targets: %s %j", async (...args) => {
    expectNoRepair(await hubEntry(...args));
  });

  it.each([{ pluginApiRange: ">=2026.10.1" }, { minGatewayVersion: "2026.10.1" }])(
    "keeps incompatible latest installs visible: %j",
    async (compatibility) => {
      vi.mocked(fetchClawHubPackageDetail).mockResolvedValue({
        package: {
          name: "@openclaw/whatsapp",
          displayName: "WhatsApp",
          family: "code-plugin",
          channel: "official",
          isOfficial: true,
          createdAt: 0,
          updatedAt: 0,
          compatibility,
        },
      });
      const entry = await hubEntry();
      expect(entry.targetResolution).toMatchObject({
        status: "unresolved",
        error: expect.stringContaining("2026.10.1"),
      });
      expect(repairCommand(entry)).toBeUndefined();
    },
  );

  it.each([
    {
      label: "lookup fails",
      arrange: () => vi.mocked(fetchClawHubPackageDetail).mockRejectedValue(new Error("HTTP 503")),
      error: "HTTP 503",
    },
    {
      label: "no latest version is published",
      arrange: () => vi.mocked(resolveLatestVersionFromPackage).mockReturnValue(null),
      error: "no latest version",
    },
  ])("keeps drift reported when $label", async ({ arrange, error }) => {
    arrange();
    const entry = await hubEntry();
    expect(entry.targetResolution).toMatchObject(
      hubTarget({ status: "unresolved", error: expect.stringContaining(error) }),
    );
  });
});

it("prefers the parsed exact npm spec package over inconsistent drift metadata", () => {
  expect(
    repairCommand({
      pluginId: "brave",
      installedVersion: "2026.6.9",
      gatewayVersion: "2026.6.10-beta.1",
      source: "npm",
      packageName: "@openclaw/other-plugin",
      spec: "@openclaw/brave-plugin@2026.6.9",
      targetResolution: {
        status: "resolved",
        packageName: "@openclaw/brave-plugin",
        requestedTarget: "2026.6.10-beta.1",
        version: "2026.6.10-beta.1",
      },
    }),
  ).toBe("openclaw plugins update @openclaw/brave-plugin@2026.6.10-beta.1");
});
