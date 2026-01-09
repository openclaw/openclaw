import { describe, expect, it, vi } from "vitest";

import type { RuntimeEnv } from "../runtime.js";
import { runOnboardingWizard } from "./onboarding.js";
import type { WizardPrompter } from "./prompts.js";

const setupProviders = vi.hoisted(() => vi.fn(async (cfg) => cfg));
const setupSkills = vi.hoisted(() => vi.fn(async (cfg) => cfg));
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const ensureWorkspaceAndSessions = vi.hoisted(() => vi.fn(async () => {}));
const writeConfigFile = vi.hoisted(() => vi.fn(async () => {}));
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({ exists: false, valid: true, config: {} })),
);
const ensureSystemdUserLingerInteractive = vi.hoisted(() =>
  vi.fn(async () => {}),
);
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const ensureControlUiAssetsBuilt = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true })),
);
const runTui = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../commands/onboard-providers.js", () => ({
  setupProviders,
}));

vi.mock("../commands/onboard-skills.js", () => ({
  setupSkills,
}));

vi.mock("../commands/health.js", () => ({
  healthCommand,
}));

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot,
    writeConfigFile,
  };
});

vi.mock("../commands/onboard-helpers.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../commands/onboard-helpers.js")>();
  return {
    ...actual,
    ensureWorkspaceAndSessions,
    detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
    openUrl: vi.fn(async () => true),
    printWizardHeader: vi.fn(),
    probeGatewayReachable: vi.fn(async () => ({ ok: true })),
    resolveControlUiLinks: vi.fn(() => ({
      httpUrl: "http://127.0.0.1:18789",
      wsUrl: "ws://127.0.0.1:18789",
    })),
  };
});

vi.mock("../commands/systemd-linger.js", () => ({
  ensureSystemdUserLingerInteractive,
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt,
}));

vi.mock("../tui/tui.js", () => ({
  runTui,
}));

describe("runOnboardingWizard", () => {
  it("skips prompts and setup steps when flags are set", async () => {
    const select: WizardPrompter["select"] = vi.fn(async () => "quickstart");
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select,
      multiselect,
      text: vi.fn(async () => ""),
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await runOnboardingWizard(
      {
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(select).not.toHaveBeenCalled();
    expect(setupProviders).not.toHaveBeenCalled();
    expect(setupSkills).not.toHaveBeenCalled();
    expect(healthCommand).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
  });
});
