import { beforeEach, describe, expect, it, vi } from "vitest";

const writeConfigFile = vi.hoisted(() => vi.fn(async () => {}));
const logConfigUpdated = vi.hoisted(() => vi.fn());
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const isValidProfileName = vi.hoisted(() => vi.fn(() => true));
const applyOnboardingLocalWorkspaceConfig = vi.hoisted(() => vi.fn((config: unknown) => config));
const applyWizardMetadata = vi.hoisted(() => vi.fn((config: unknown) => config));
const ensureWorkspaceAndSessions = vi.hoisted(() => vi.fn(async () => {}));
const waitForGatewayReachable = vi.hoisted(() => vi.fn(async () => {}));
const canEnableRescueWatchdog = vi.hoisted(() => vi.fn(() => true));
const resolveMonitoredProfileName = vi.hoisted(() => vi.fn(() => "default"));
const setupRescueWatchdog = vi.hoisted(() => vi.fn());
const inferAuthChoiceFromFlags = vi.hoisted(() =>
  vi.fn(() => ({
    matches: [],
    choice: undefined,
  })),
);
const applyNonInteractiveGatewayConfig = vi.hoisted(() =>
  vi.fn(() => ({
    nextConfig: {},
    port: 18_789,
    bind: "loopback",
    authMode: "token",
    tailscaleMode: "off",
    gatewayToken: "session-token",
  })),
);
const logNonInteractiveOnboardingJson = vi.hoisted(() => vi.fn());
const applyNonInteractiveSkillsConfig = vi.hoisted(() =>
  vi.fn((params: { nextConfig: unknown }) => params.nextConfig),
);
const resolveNonInteractiveWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const installGatewayDaemonNonInteractive = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../config/config.js", () => ({
  resolveGatewayPort: vi.fn(() => 18_789),
  writeConfigFile,
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated,
}));

vi.mock("../../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
}));

vi.mock("../../cli/profile-utils.js", () => ({
  isValidProfileName,
}));

vi.mock("../daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
}));

vi.mock("../onboard-config.js", () => ({
  applyOnboardingLocalWorkspaceConfig,
}));

vi.mock("../onboard-helpers.js", () => ({
  applyWizardMetadata,
  DEFAULT_WORKSPACE: "/tmp/default-workspace",
  ensureWorkspaceAndSessions,
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  waitForGatewayReachable,
}));

vi.mock("../onboard-rescue.js", () => ({
  canEnableRescueWatchdog,
  resolveMonitoredProfileName,
  setupRescueWatchdog,
}));

vi.mock("./local/auth-choice-inference.js", () => ({
  inferAuthChoiceFromFlags,
}));

vi.mock("./local/gateway-config.js", () => ({
  applyNonInteractiveGatewayConfig,
}));

vi.mock("./local/output.js", () => ({
  logNonInteractiveOnboardingJson,
}));

vi.mock("./local/skills-config.js", () => ({
  applyNonInteractiveSkillsConfig,
}));

vi.mock("./local/workspace.js", () => ({
  resolveNonInteractiveWorkspaceDir,
}));

vi.mock("./local/daemon-install.js", () => ({
  installGatewayDaemonNonInteractive,
}));

const { runNonInteractiveOnboardingLocal } = await import("./local.js");

describe("runNonInteractiveOnboardingLocal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSystemdUserServiceAvailable.mockResolvedValue(true);
    isValidProfileName.mockReturnValue(true);
    canEnableRescueWatchdog.mockReturnValue(true);
    resolveMonitoredProfileName.mockReturnValue("default");
    inferAuthChoiceFromFlags.mockReturnValue({
      matches: [],
      choice: undefined,
    });
    applyNonInteractiveGatewayConfig.mockReturnValue({
      nextConfig: {},
      port: 18_789,
      bind: "loopback",
      authMode: "token",
      tailscaleMode: "off",
      gatewayToken: "session-token",
    });
    resolveNonInteractiveWorkspaceDir.mockReturnValue("/tmp/workspace");
    installGatewayDaemonNonInteractive.mockResolvedValue(true);
    setupRescueWatchdog.mockResolvedValue({
      enabled: true,
      monitoredProfile: "default",
      rescueProfile: "rescue",
      rescuePort: 19_789,
      rescueWorkspace: "/tmp/workspace-rescue",
      cronAction: "created",
      cronJobId: "job-1",
    });
  });

  it("exits non-zero when rescue watchdog setup fails", async () => {
    setupRescueWatchdog.mockRejectedValueOnce(new Error("boom"));
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await runNonInteractiveOnboardingLocal({
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        rescueWatchdog: true,
        skipHealth: true,
        skipSkills: true,
      },
      runtime,
      baseConfig: {},
    });

    expect(runtime.error).toHaveBeenCalledWith("Rescue watchdog setup failed: boom");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(logNonInteractiveOnboardingJson).not.toHaveBeenCalled();
  });

  it("rejects invalid OPENCLAW_PROFILE before forcing daemon install", async () => {
    const previousProfile = process.env.OPENCLAW_PROFILE;
    try {
      process.env.OPENCLAW_PROFILE = "../oops";
      resolveMonitoredProfileName.mockReturnValue("../oops");
      isValidProfileName.mockReturnValue(false);
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      await runNonInteractiveOnboardingLocal({
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          rescueWatchdog: true,
          skipHealth: true,
          skipSkills: true,
        },
        runtime,
        baseConfig: {},
      });

      expect(runtime.error).toHaveBeenCalledWith('Invalid OPENCLAW_PROFILE: "../oops"');
      expect(runtime.exit).toHaveBeenCalledWith(2);
      expect(installGatewayDaemonNonInteractive).not.toHaveBeenCalled();
      expect(setupRescueWatchdog).not.toHaveBeenCalled();
    } finally {
      if (previousProfile === undefined) {
        delete process.env.OPENCLAW_PROFILE;
      } else {
        process.env.OPENCLAW_PROFILE = previousProfile;
      }
    }
  });

  it("exits non-zero when the primary managed service install fails before rescue setup", async () => {
    installGatewayDaemonNonInteractive.mockResolvedValueOnce(false);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await runNonInteractiveOnboardingLocal({
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        rescueWatchdog: true,
        skipHealth: true,
        skipSkills: true,
      },
      runtime,
      baseConfig: {},
    });

    expect(runtime.error).toHaveBeenCalledWith(
      "Rescue watchdog requires a healthy primary managed service. Gateway service install failed during onboarding, so rescue watchdog was not configured.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(setupRescueWatchdog).not.toHaveBeenCalled();
    expect(logNonInteractiveOnboardingJson).not.toHaveBeenCalled();
  });
});
