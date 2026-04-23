import { beforeEach, describe, expect, it, vi } from "vitest";

const callOrder: string[] = [];

const maybeRepairBundledPluginRuntimeDeps = vi.fn(async () => {
  callOrder.push("repair");
});
const loadAndMaybeMigrateDoctorConfig = vi.fn(async () => {
  callOrder.push("config");
  return {
    cfg: {},
    path: "/tmp/openclaw.json",
    sourceConfigValid: true,
  };
});

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
}));

vi.mock("../commands/doctor-prompter.js", () => ({
  createDoctorPrompter: vi.fn(() => ({
    confirm: vi.fn(async () => true),
    confirmAutoFix: vi.fn(async () => true),
    confirmAggressiveAutoFix: vi.fn(async () => true),
    confirmRuntimeRepair: vi.fn(async () => true),
    select: vi.fn(async (_params: unknown, fallback: unknown) => fallback),
    shouldRepair: true,
    shouldForce: false,
    repairMode: {
      shouldRepair: true,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: false,
    },
  })),
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  printWizardHeader: vi.fn(),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => "/tmp/openclaw"),
}));

vi.mock("../commands/doctor-update.js", () => ({
  maybeOfferUpdateBeforeDoctor: vi.fn(async () => ({ handled: false })),
}));

vi.mock("../commands/doctor-ui.js", () => ({
  maybeRepairUiProtocolFreshness: vi.fn(async () => {}),
}));

vi.mock("../commands/doctor-install.js", () => ({
  noteSourceInstallIssues: vi.fn(),
}));

vi.mock("../commands/doctor-platform-notes.js", () => ({
  noteStartupOptimizationHints: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw.json",
  readConfigFileSnapshot: vi.fn(async () => ({
    config: {
      channels: {
        feishu: {
          appId: "app-123",
        },
      },
    },
  })),
}));

vi.mock("../commands/doctor-bundled-plugin-runtime-deps.js", () => ({
  maybeRepairBundledPluginRuntimeDeps,
}));

vi.mock("../commands/doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig,
}));

vi.mock("./doctor-health-contributions.js", () => ({
  runDoctorHealthContributions: vi.fn(async () => {}),
}));

describe("doctor command bundled runtime deps preflight", () => {
  beforeEach(() => {
    callOrder.length = 0;
    maybeRepairBundledPluginRuntimeDeps.mockClear();
    loadAndMaybeMigrateDoctorConfig.mockClear();
  });

  it("repairs bundled runtime deps before doctor config loading", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const { doctorCommand } = await import("./doctor-health.js");

    await doctorCommand(runtime, { nonInteractive: true });

    expect(callOrder.slice(0, 2)).toEqual(["repair", "config"]);
    expect(maybeRepairBundledPluginRuntimeDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime,
        packageRoot: "/tmp/openclaw",
        includeConfiguredChannels: true,
        config: expect.objectContaining({
          channels: expect.objectContaining({
            feishu: expect.objectContaining({
              appId: "app-123",
            }),
          }),
        }),
      }),
    );
  });
});
