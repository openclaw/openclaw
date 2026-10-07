import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ClawDiagnostic } from "../claws/types.js";
import { plan } from "../claws/update-apply.test-helpers.js";
import type { buildClawUpdatePlan } from "../claws/update-plan.js";
import type { RuntimeEnv } from "../runtime.js";
import * as cliTestHelpers from "./claws-cli.test-helpers.js";

const enabledClawsLabsConfig = { gateway: { controlUi: { experimental: { claws: true } } } };

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  readCurrentConfigForPolicyCheck: vi.fn(),
  listConfiguredMcpServers: vi.fn(),
  openExistingOpenClawStateDatabaseReadOnly: vi.fn(),
  closeReadOnlyDatabase: vi.fn(),
  readClawStatus: vi.fn(),
  buildClawUpdatePlan: vi.fn(),
  applyClawUpdatePlan: vi.fn(),
  withOpenClawStateLease: vi.fn(),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../config/io.js", async () => ({
  ...(await vi.importActual<typeof import("../config/io.js")>("../config/io.js")),
  readCurrentConfigForPolicyCheck: mocks.readCurrentConfigForPolicyCheck,
}));

vi.mock("../config/mcp-config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/mcp-config.js")>("../config/mcp-config.js")),
  listConfiguredMcpServers: mocks.listConfiguredMcpServers,
}));

vi.mock("../state/openclaw-state-db.js", async () => ({
  ...(await vi.importActual<typeof import("../state/openclaw-state-db.js")>(
    "../state/openclaw-state-db.js",
  )),
  openExistingOpenClawStateDatabaseReadOnly: mocks.openExistingOpenClawStateDatabaseReadOnly,
}));

vi.mock("../claws/lifecycle-state.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/lifecycle-state.js")>(
    "../claws/lifecycle-state.js",
  )),
  readClawStatus: mocks.readClawStatus,
}));

vi.mock("../claws/update-plan.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/update-plan.js")>("../claws/update-plan.js")),
  buildClawUpdatePlan: mocks.buildClawUpdatePlan,
}));

vi.mock("../claws/update-apply.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/update-apply.js")>("../claws/update-apply.js")),
  applyClawUpdatePlan: mocks.applyClawUpdatePlan,
}));

vi.mock("../state/openclaw-state-lease.js", async () => ({
  ...(await vi.importActual<typeof import("../state/openclaw-state-lease.js")>(
    "../state/openclaw-state-lease.js",
  )),
  withOpenClawStateLease: mocks.withOpenClawStateLease,
}));

vi.mock("./plugins-lifecycle-client.js", () => ({
  resolvePluginBatchReload: vi.fn(async () => undefined),
}));

const { runClawsUpdateCommand } = await import("./claws-update-cli.runtime.js");
const { runClawsAddCommand, runClawsInspectCommand } = await import("./claws-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const logs: string[] = [];
const errors: string[] = [];
const runtime: RuntimeEnv = {
  log: vi.fn((value: unknown) => logs.push(String(value))),
  error: vi.fn((value: unknown) => errors.push(String(value))),
  exit: vi.fn(),
};

async function writeLegacyProfilePackage(): Promise<string> {
  const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
  await mkdir(join(root, "profiles"));
  await writeFile(
    join(root, "profiles", "openclaw.yml"),
    [
      "schemaVersion: 1",
      "agent:",
      "  model: { primary: acme/primary, fallbacks: [acme/fallback] }",
      "  subagents: { allowAgents: [researcher], delegationMode: prefer }",
      "  tools: { allow: [read] }",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

function setRecordedSource(
  root: string,
  overrides: Record<string, unknown> = {},
  agentId = "demo-agent",
): void {
  mocks.readClawStatus.mockResolvedValue({
    records: [
      {
        install: {
          agentId,
          claw: {
            kind: "package",
            name: "@acme/demo-agent",
            version: "1.0.0",
            packageRoot: root,
            manifestPath: join(root, "openclaw.claw.json"),
            integrityKind: "development-snapshot",
            integrity: "sha256:old",
            ...overrides,
          },
        },
      },
    ],
  });
}

function parsedOutput(): Record<string, unknown> {
  return JSON.parse(logs[0] ?? "{}");
}

describe("recorded local Claw Update with a released v1 profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    logs.length = 0;
    errors.length = 0;
    mocks.getRuntimeConfig.mockReturnValue(enabledClawsLabsConfig);
    mocks.readCurrentConfigForPolicyCheck.mockReturnValue(enabledClawsLabsConfig);
    mocks.listConfiguredMcpServers.mockResolvedValue({
      ok: true,
      path: "config",
      config: {},
      mcpServers: {},
    });
    mocks.openExistingOpenClawStateDatabaseReadOnly.mockReturnValue({
      db: { prepare: () => ({ get: () => ({ 1: 1 }) }) },
      walMaintenance: { close: mocks.closeReadOnlyDatabase },
    });
    mocks.buildClawUpdatePlan.mockImplementation(
      async (input: { agentId: string; diagnostics?: ClawDiagnostic[] }) => ({
        ...plan([]),
        agentId: input.agentId,
        planIntegrity: "sha256:legacy-local-preview",
        diagnostics: input.diagnostics ?? [],
      }),
    );
    mocks.applyClawUpdatePlan.mockResolvedValue({
      agentId: "demo-agent",
      previousClaw: { version: "1.0.0" },
      targetClaw: { version: "1.2.3" },
    });
    mocks.withOpenClawStateLease.mockImplementation(
      async (_options, run) => await run({ assertOwned: vi.fn() }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("strips and discloses host-owned settings for the exact recorded local source", async () => {
    const root = await writeLegacyProfilePackage();
    setRecordedSource(root);

    await runClawsUpdateCommand("demo-agent", { dryRun: true, json: true }, runtime);

    const input = mocks.buildClawUpdatePlan.mock.calls[0]?.[0] as
      | Parameters<typeof buildClawUpdatePlan>[0]
      | undefined;
    expect(input?.targetOpenClawProfile?.agent).not.toHaveProperty("model");
    expect(input?.targetOpenClawProfile?.agent).not.toHaveProperty("subagents");
    expect(input?.targetSource.integrityKind).toBe("development-snapshot");
    expect(input?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "legacy_openclaw_model_ignored", level: "warning" }),
        expect.objectContaining({ code: "legacy_openclaw_subagents_ignored", level: "warning" }),
      ]),
    );
    expect(parsedOutput()).toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: "legacy_openclaw_model_ignored" }),
        expect.objectContaining({ code: "legacy_openclaw_subagents_ignored" }),
      ],
    });

    logs.length = 0;
    await runClawsUpdateCommand("demo-agent", { dryRun: true }, runtime);
    expect(logs.join("\n")).toContain("host model settings are operator-owned");
    expect(logs.join("\n")).toContain("named delegation settings are operator-owned");

    logs.length = 0;
    await runClawsUpdateCommand(
      "demo-agent",
      { yes: true, planIntegrity: "sha256:legacy-local-preview" },
      runtime,
    );
    expect(mocks.applyClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: "sha256:legacy-local-preview" }),
      expect.objectContaining({ targetDiagnostics: input?.diagnostics }),
      expect.objectContaining({ consentPlanIntegrity: "sha256:legacy-local-preview" }),
    );
    expect(logs.join("\n")).toContain("host model settings are operator-owned");
    expect(logs.join("\n")).toContain("named delegation settings are operator-owned");
  });

  it("updates an installed alias from its exact recorded local source", async () => {
    const root = await writeLegacyProfilePackage();
    setRecordedSource(root, {}, "my-demo");

    await runClawsUpdateCommand("my-demo", { dryRun: true, json: true }, runtime);

    const input = mocks.buildClawUpdatePlan.mock.calls[0]?.[0] as
      | Parameters<typeof buildClawUpdatePlan>[0]
      | undefined;
    expect(input?.agentId).toBe("my-demo");
    expect(input?.targetOpenClawProfile?.agent).not.toHaveProperty("model");
    expect(input?.targetOpenClawProfile?.agent).not.toHaveProperty("subagents");
    expect(input?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "legacy_openclaw_model_ignored", level: "warning" }),
        expect.objectContaining({ code: "legacy_openclaw_subagents_ignored", level: "warning" }),
      ]),
    );
    expect(parsedOutput()).toMatchObject({ agentId: "my-demo" });

    logs.length = 0;
    await runClawsUpdateCommand(
      "my-demo",
      { yes: true, planIntegrity: "sha256:legacy-local-preview" },
      runtime,
    );
    expect(mocks.applyClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "my-demo" }),
      expect.objectContaining({ targetDiagnostics: input?.diagnostics }),
      expect.objectContaining({ consentPlanIntegrity: "sha256:legacy-local-preview" }),
    );
  });

  it.each([
    ["artifact record", { integrityKind: "artifact" }, "clawhub_official_claw_required"],
    [
      "different recorded manifest",
      { manifestPath: "/tmp/other/openclaw.claw.json" },
      "legacy_openclaw_profile_requires_conversion",
    ],
  ])("keeps %s strict", async (_case, override, code) => {
    const root = await writeLegacyProfilePackage();
    setRecordedSource(root, override);

    await runClawsUpdateCommand("demo-agent", { dryRun: true, json: true }, runtime);

    expect(mocks.buildClawUpdatePlan).not.toHaveBeenCalled();
    expect(parsedOutput()).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });

  it("keeps --from, fresh Add, and Inspect strict", async () => {
    const root = await writeLegacyProfilePackage();
    setRecordedSource(root);

    await runClawsUpdateCommand("demo-agent", { from: root, dryRun: true, json: true }, runtime);
    expect(mocks.buildClawUpdatePlan).not.toHaveBeenCalled();
    expect(parsedOutput()).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "legacy_openclaw_profile_requires_conversion" }),
      ]),
    });

    logs.length = 0;
    await runClawsAddCommand(root, { dryRun: true, json: true }, runtime);
    expect(parsedOutput()).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "legacy_openclaw_profile_requires_conversion" }),
      ]),
    });

    logs.length = 0;
    await runClawsInspectCommand(root, { json: true }, runtime);
    expect(parsedOutput()).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "legacy_openclaw_profile_requires_conversion" }),
      ]),
    });
  });
});
