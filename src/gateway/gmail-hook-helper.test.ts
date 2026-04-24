import { describe, expect, it, vi } from "vitest";
import {
  applyGmailSetup,
  probeGmailHook,
} from "./gmail-hook-helper.js";

const BASE_CONFIG = {
  gateway: {
    mode: "local",
    port: 18789,
    tls: { enabled: false },
  },
  hooks: {
    enabled: true,
    token: "hook-token",
    gmail: {
      account: "jarvis.bot@gmail.com",
      label: "JARVIS",
      topic: "projects/demo/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "push-token",
      tailscale: {
        mode: "funnel" as const,
      },
    },
  },
};

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    callGatewayScoped: vi.fn().mockResolvedValue({ ok: true }),
    hasBinary: vi.fn((name: string) =>
      name === "gcloud" || name === "gog" || name === "tailscale"),
    loadConfig: () => BASE_CONFIG,
    readConfigFileSnapshot: vi.fn().mockResolvedValue({
      exists: true,
      valid: true,
      config: BASE_CONFIG,
    }),
    resolveGmailHookRuntimeConfig: vi.fn((config, helperOverrides) => {
      const gmailConfig = config.hooks?.gmail ?? {};
      const account = helperOverrides.account ?? gmailConfig.account;
      const label = helperOverrides.label ?? gmailConfig.label;
      const topic = helperOverrides.topic ?? gmailConfig.topic;
      const subscription =
        helperOverrides.subscription ?? gmailConfig.subscription;
      const tailscaleMode =
        helperOverrides.tailscaleMode ?? gmailConfig.tailscale?.mode;

      if (!config.hooks?.token) {
        return { ok: false, error: "hooks.token missing (needed for gmail hook)" };
      }
      if (!account) {
        return { ok: false, error: "gmail account required" };
      }
      if (!topic) {
        return { ok: false, error: "gmail topic required" };
      }

      return {
        ok: true,
        value: {
          account,
          label,
          topic,
          subscription,
          pushToken: gmailConfig.pushToken,
          hookToken: config.hooks.token,
          hookUrl: "http://127.0.0.1:8787/hooks/gmail",
          includeBody: true,
          maxBytes: 20000,
          renewEveryMinutes: 720,
          serve: {
            bind: "127.0.0.1",
            port: 8788,
            path: "/",
          },
          tailscale: {
            mode: tailscaleMode,
            path: "/gmail-pubsub",
            target: undefined,
          },
        },
      };
    }),
    runCommandWithTimeout: vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "gcloud") {
        return Promise.resolve({
          code: 0,
          stdout: "jarvis.bot@gmail.com\n",
          stderr: "",
        });
      }

      if (args[0] === "gog") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            account: {
              credentials_exists: true,
              email: "jarvis.bot@gmail.com",
            },
            config: {
              exists: true,
            },
          }),
          stderr: "",
        });
      }

      if (args[0] === "tailscale") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            BackendState: "Running",
            CurrentTailnet: { Name: "jarvis.ts.net" },
            Self: { DNSName: "desktop.jarvis.ts.net." },
            Health: [],
          }),
          stderr: "",
        });
      }

      return Promise.resolve({
        code: 0,
        stdout: "",
        stderr: "",
      });
    }),
    runSetupCommand: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("gmail-hook-helper", () => {
  it("returns missing when hooks.gmail is not configured", async () => {
    const deps = createDeps({
      readConfigFileSnapshot: vi.fn().mockResolvedValue({
        exists: true,
        valid: true,
        config: {
          gateway: BASE_CONFIG.gateway,
          hooks: {
            enabled: true,
            token: "hook-token",
          },
        },
      }),
    });

    const result = await probeGmailHook(
      { url: "ws://127.0.0.1:18789" },
      deps as never,
    );

    expect(result).toMatchObject({
      action: "probe-gmail-hook",
      state: "missing",
      account: null,
      label: "INBOX",
      topic: "gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      tailscaleMode: "funnel",
    });
  });

  it("reports dependency or auth failures as error when gmail config is present", async () => {
    const deps = createDeps({
      runCommandWithTimeout: vi.fn().mockResolvedValue({
        code: 1,
        stdout: "",
        stderr: "No credentialed accounts.",
      }),
    });

    const result = await probeGmailHook(
      { url: "ws://127.0.0.1:18789" },
      deps as never,
    );

    expect(result).toMatchObject({
      state: "error",
      message: "No credentialed accounts.",
      account: "jarvis.bot@gmail.com",
      project: "demo",
    });
    expect(result.dependencies.find((entry) => entry.id === "gcloud")).toMatchObject({
      available: true,
      ready: false,
    });
  });

  it("returns ready after a successful apply and preserves the minimal setup input contour", async () => {
    const runSetupCommand = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      runSetupCommand,
    });

    const result = await applyGmailSetup(
      {
        account: "jarvis.bot@gmail.com",
        project: "demo",
        label: "JARVIS",
        topic: "gog-gmail-watch",
        subscription: "gog-gmail-watch-push",
        tailscaleMode: "funnel",
      },
      { url: "ws://127.0.0.1:18789" },
      deps as never,
    );

    expect(runSetupCommand).toHaveBeenCalledWith(
      {
        account: "jarvis.bot@gmail.com",
        project: "demo",
        label: "JARVIS",
        topic: "gog-gmail-watch",
        subscription: "gog-gmail-watch-push",
        tailscaleMode: "funnel",
      },
      { url: "ws://127.0.0.1:18789" },
      expect.any(Object),
    );
    expect(result).toMatchObject({
      action: "probe-gmail-hook",
      state: "ready",
      gatewayReachable: true,
      warning: "Email delivery is not end-to-end verified in this milestone.",
    });
  });

  it("keeps advanced behavior delegated to the existing setup path instead of overwriting it in the helper", async () => {
    const runSetupCommand = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      runSetupCommand,
    });

    await applyGmailSetup(
      {
        account: "jarvis.bot@gmail.com",
        project: "demo",
        label: "JARVIS",
        topic: "gog-gmail-watch",
        subscription: "gog-gmail-watch-push",
        tailscaleMode: "serve",
      },
      { url: "ws://127.0.0.1:18789" },
      deps as never,
    );

    expect(runSetupCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "jarvis.bot@gmail.com",
        project: "demo",
        label: "JARVIS",
        topic: "gog-gmail-watch",
        subscription: "gog-gmail-watch-push",
        tailscaleMode: "serve",
      }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(runSetupCommand.mock.calls[0]?.[0]).not.toHaveProperty("hookUrl");
    expect(runSetupCommand.mock.calls[0]?.[0]).not.toHaveProperty("pushToken");
    expect(runSetupCommand.mock.calls[0]?.[0]).not.toHaveProperty("renewEveryMinutes");
  });
});
