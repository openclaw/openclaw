import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { RuntimeEnv } from "../runtime.js";

const runTui = vi.hoisted(() => vi.fn(async () => {}));
const probeGatewayReachable = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const setupOnboardingShellCompletion = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../commands/onboard-helpers.js", () => ({
  detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
  openUrl: vi.fn(async () => false),
  probeGatewayReachable,
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  waitForGatewayReachable: vi.fn(async () => {}),
}));

vi.mock("../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: vi.fn(async () => ({
    programArguments: [],
    workingDirectory: "/tmp",
    environment: {},
  })),
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  GATEWAY_DAEMON_RUNTIME_OPTIONS: [{ value: "node", label: "Node" }],
}));

vi.mock("../commands/health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(() => "health failed"),
}));

vi.mock("../commands/health.js", () => ({
  healthCommand: vi.fn(async () => {}),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    isLoaded: vi.fn(async () => false),
    restart: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
  })),
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable: vi.fn(async () => false),
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../terminal/restore.js", () => ({
  restoreTerminalState: vi.fn(),
}));

vi.mock("../tui/tui.js", () => ({
  runTui,
}));

vi.mock("./onboarding.completion.js", () => ({
  setupOnboardingShellCompletion,
}));

import { finalizeOnboardingWizard } from "./onboarding.finalize.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("finalizeOnboardingWizard", () => {
  beforeEach(() => {
    runTui.mockClear();
    probeGatewayReachable.mockClear();
    setupOnboardingShellCompletion.mockClear();
  });

  it("resolves gateway password SecretRef for probe and TUI", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "resolved-gateway-password";
    const select = vi.fn(async (params: { message: string }) => {
      if (params.message === "How do you want to hatch your bot?") {
        return "tui";
      }
      return "later";
    });
    const prompter = buildWizardPrompter({
      select: select as never,
      confirm: vi.fn(async () => false),
    });
    const runtime = createRuntime();

    try {
      await finalizeOnboardingWizard({
        flow: "quickstart",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          skipHealth: true,
          skipUi: false,
        },
        baseConfig: {},
        nextConfig: {
          gateway: {
            auth: {
              mode: "password",
              password: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_GATEWAY_PASSWORD",
              },
            },
          },
          tools: {
            web: {
              search: {
                apiKey: "",
              },
            },
          },
        },
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "password",
          gatewayToken: undefined,
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter,
        runtime,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }

    expect(probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        password: "resolved-gateway-password",
      }),
    );
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        password: "resolved-gateway-password",
      }),
    );
  });
});
