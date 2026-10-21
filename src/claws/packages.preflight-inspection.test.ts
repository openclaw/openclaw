import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { describe, expect, it, vi } from "vitest";
import type { installPluginFromClawHub } from "../plugins/clawhub.js";
import { preflightClawPackage } from "./packages.js";
import { emptyPluginCapabilityEvidence } from "./packages.test-support.js";

vi.mock("@openclaw/fs-safe/temp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/temp")>();
  return { ...actual, tempWorkspace: vi.fn(actual.tempWorkspace) };
});

const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const pluginPackage = {
  kind: "plugin",
  source: "clawhub",
  ref: "@owner/audit",
  version: "2.0.1",
  integrity,
} as const;

type Probe = typeof installPluginFromClawHub;
type PluginProbe = Extract<Awaited<ReturnType<Probe>>, { ok: true }>;
function pluginProbe(overrides: Partial<PluginProbe> = {}): PluginProbe {
  return {
    ok: true,
    pluginId: "audit",
    packageName: "@owner/audit",
    targetDir: "/tmp/plugin",
    extensions: [],
    artifactInspection: { format: "openclaw", mapped: ["plugin"], unavailable: [] },
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "@owner/audit",
      clawhubFamily: "code-plugin",
      integrity,
    },
    ...overrides,
  };
}
const withStagedInspection = (probe: Probe) => async (request: Parameters<Probe>[0]) => {
  const result = await probe(request);
  if (result.ok) {
    await request.onPluginArtifactInspect?.({
      pluginId: result.pluginId,
      stagedArtifactDir: "/tmp/staged-audit",
      mode: "install",
    });
  }
  return result;
};
const inspectPluginCapabilities = vi.fn((_rootDir: string, pluginId: string) => ({
  ...emptyPluginCapabilityEvidence,
  grantsByPluginId: { [pluginId]: emptyPluginCapabilityEvidence.grants },
}));
type PreflightOptions = NonNullable<Parameters<typeof preflightClawPackage>[2]>;
const conflict = {
  ok: false,
  code: "plugin_version_conflict",
  error: "Installed plugin has a different version.",
  installedVersion: "1.0.0",
  expectedVersion: pluginPackage.version,
  request: {} as never,
} as const;
type ProbeFixture = Probe | Partial<PluginProbe>;
function preflight(probe: ProbeFixture, options: PreflightOptions = {}) {
  return preflightClawPackage(pluginPackage, "/tmp/workspace", {
    ...options,
    deps: {
      preflightPlugin: async () => ({ ok: true, action: "install", request: {} as never }),
      probePlugin: withStagedInspection(
        typeof probe === "function" ? probe : async () => pluginProbe(probe),
      ),
      inspectPluginCapabilities,
      ...options.deps,
    },
  });
}
const conflictingPreflight = (probe: ProbeFixture = {}, config?: PreflightOptions["config"]) =>
  preflight(probe, { config, deps: { preflightPlugin: async () => conflict } });
describe("preflightClawPackage isolated plugin inspection", () => {
  it("rejects generic agent bundles outside the Claw schema-v1 format contract", async () => {
    const result = await preflight({
      targetDir: "/tmp/extensions/audit",
      artifactInspection: { format: "agent", mapped: ["skills"], unavailable: [] },
    });
    expect(result).toEqual({
      ok: false,
      code: "plugin_artifact_format_unsupported",
      message: "Plugin @owner/audit@2.0.1 uses unsupported Claw extension format agent.",
    });
  });

  it("preserves live extension-directory conflict checks for a new plugin install", async () => {
    const liveProbe = vi.fn(async () => ({
      ok: false as const,
      code: "plugin_target_exists" as never,
      error: "plugin already exists: /tmp/extensions/audit",
    }));

    await expect(preflight(liveProbe)).resolves.toMatchObject({
      ok: false,
      message: "plugin already exists: /tmp/extensions/audit",
    });
    expect(liveProbe).toHaveBeenCalledWith(
      expect.not.objectContaining({ extensionsDir: expect.anything() }),
    );
  });

  it("preserves canonical inspection when an installed plugin version conflicts", async () => {
    const result = await conflictingPreflight({
      targetDir: "/tmp/claw-plugin-probe/audit",
      artifactInspection: {
        format: "claude",
        mapped: ["commands", "skills"],
        unavailable: ["agents"],
      },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "plugin_version_conflict",
      installedVersion: "1.0.0",
      integrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
      installId: "audit",
      detectedFormat: "claude",
      mapped: ["commands", "skills"],
      unavailable: ["agents"],
      adapterIdentity: expect.stringMatching(/^openclaw\//),
    });
  });

  it("rejects a disabled installed plugin before treating a version conflict as upgradable", async () => {
    await expect(
      conflictingPreflight(undefined, { plugins: { entries: { audit: { enabled: false } } } }),
    ).resolves.toMatchObject({ ok: false, code: "plugin_disabled" });
  });

  it("keeps canonical inspection when isolated probe cleanup reports failure", async () => {
    let cleanupFailureInjected = false;
    vi.mocked(tempWorkspace).mockImplementationOnce(async (options) => {
      const actual =
        await vi.importActual<typeof import("@openclaw/fs-safe/temp")>("@openclaw/fs-safe/temp");
      const workspace = await actual.tempWorkspace(options);
      const cleanup = workspace.cleanup.bind(workspace);
      workspace.cleanup = async () => {
        await cleanup();
        cleanupFailureInjected = true;
        throw new Error("temporary directory cleanup failed");
      };
      return workspace;
    });
    let probeDirectory: string | undefined;
    const isolatedProbe = vi.fn(async (params: { extensionsDir?: string }) => {
      probeDirectory = params.extensionsDir;
      expect((await lstat(probeDirectory!)).isDirectory()).toBe(true);
      return pluginProbe({ targetDir: join(probeDirectory!, "audit") });
    });

    const result = await preflight(isolatedProbe, {
      deps: {
        preflightPlugin: vi.fn(async () => ({
          ok: true as const,
          action: "reuse" as const,
          request: {} as never,
          installedId: "audit",
          installedVersion: "2.0.1",
          installedIntegrity: integrity,
          installedAt: "2026-08-06T00:00:00.000Z",
        })),
      },
    });
    expect(result).toMatchObject({
      ok: true,
      action: "reuse",
      installId: "audit",
      installedIntegrity: integrity,
      installedAt: "2026-08-06T00:00:00.000Z",
      detectedFormat: "openclaw",
      mapped: ["plugin"],
      unavailable: [],
    });
    expect(cleanupFailureInjected).toBe(true);
    await expect(lstat(probeDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
