import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { ensureAgentAssistedGatewayRuntime } from "./setup.assisted-gateway.js";

const spawn = vi.hoisted(() => vi.fn());
const probeGateway = vi.hoisted(() => vi.fn());
const resolveGatewayProgramArguments = vi.hoisted(() => vi.fn());
const killProcessTree = vi.hoisted(() => vi.fn());
const detach = vi.hoisted(() => vi.fn());
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() => vi.fn(() => [] as number[]));
const readGatewayProcessArgsSync = vi.hoisted(() => vi.fn());
const defaultGatewayBindMode = vi.hoisted(() => vi.fn(() => "loopback"));
const isLoopbackAddress = vi.hoisted(() => vi.fn((host: string) => host === "127.0.0.1"));
const resolveGatewayBindHost = vi.hoisted(() => vi.fn(async () => "127.0.0.1"));
const resolveGatewayListenHosts = vi.hoisted(() =>
  vi.fn(async (host: string) => (host === "127.0.0.1" ? ["127.0.0.1", "::1"] : [host])),
);
const inspectPortUsage = vi.hoisted(() => vi.fn());
const resolveSetupSecretInputString = vi.hoisted(() => vi.fn());
const loadGatewayTlsRuntime = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  resolveControlUiLinks: ({ tlsEnabled }: { tlsEnabled?: boolean }) => ({
    httpUrl: `${tlsEnabled ? "https" : "http"}://127.0.0.1:18789/`,
    wsUrl: `${tlsEnabled ? "wss" : "ws"}://127.0.0.1:18789`,
  }),
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway,
}));

vi.mock("../config/paths.js", () => ({
  DEFAULT_GATEWAY_PORT: 18789,
  resolveConfigPath: () => "/tmp/openclaw.json",
}));

vi.mock("../gateway/net.js", () => ({
  defaultGatewayBindMode,
  isLoopbackAddress,
  resolveGatewayBindHost,
  resolveGatewayListenHosts,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree,
}));

vi.mock("../process/child-process-bridge.js", () => ({
  attachChildProcessBridge: () => ({ detach }),
}));

vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync,
  readGatewayProcessArgsSync,
}));

vi.mock("../infra/ports.js", () => ({ inspectPortUsage }));

vi.mock("./setup.secret-input.js", () => ({ resolveSetupSecretInputString }));

vi.mock("../infra/tls/gateway.js", () => ({ loadGatewayTlsRuntime }));

type MockChild = EventEmitter & {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: PassThrough;
  stderr: PassThrough;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = 4321;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function matchingGatewayConfigSnapshot(auth: Record<string, unknown> = { mode: "token" }) {
  return {
    path: "/tmp/openclaw.json",
    config: {
      gateway: {
        port: 18789,
        bind: "loopback",
        auth,
        tailscale: { mode: "off" },
      },
    },
  };
}

describe("agent-assisted Gateway runtime", () => {
  const settings = {
    port: 18789,
    bind: "loopback" as const,
    authMode: "token" as const,
    gatewayToken: "test-token",
    tailscaleMode: "off" as const,
    tailscaleResetOnExit: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    spawn.mockReset();
    probeGateway.mockReset().mockResolvedValue({ ok: false });
    resolveGatewayProgramArguments.mockReset();
    killProcessTree.mockReset();
    detach.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReset().mockReturnValue([]);
    readGatewayProcessArgsSync
      .mockReset()
      .mockReturnValue(["/usr/bin/node", "/app/openclaw.mjs", "gateway", "--port", "18789"]);
    resolveGatewayBindHost.mockReset().mockResolvedValue("127.0.0.1");
    resolveGatewayListenHosts
      .mockReset()
      .mockImplementation(async (host: string) =>
        host === "127.0.0.1" ? ["127.0.0.1", "::1"] : [host],
      );
    inspectPortUsage.mockReset().mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4321, address: "127.0.0.1:18789" }],
      hints: [],
    });
    resolveSetupSecretInputString
      .mockReset()
      .mockImplementation(async ({ value }: { value?: unknown }) =>
        typeof value === "string" ? value : undefined,
      );
    loadGatewayTlsRuntime.mockReset().mockResolvedValue({
      enabled: false,
      required: false,
    });
    resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["/usr/bin/node", "/app/openclaw.mjs", "gateway", "--port", "18789"],
      workingDirectory: "/app",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not send active auth to an unverified listener before starting a Gateway", async () => {
    resolveGatewayProgramArguments.mockRejectedValueOnce(new Error("program lookup stopped"));

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("program lookup stopped");

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reuses a verified existing Gateway that accepts the active security settings", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    readGatewayProcessArgsSync.mockReturnValue([
      "/usr/bin/node",
      "/app/openclaw.mjs",
      "gateway",
      "run",
      "--bind=loopback",
      "--tailscale",
      "off",
    ]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: { mode: "token" },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        connectErrorDetails: { code: "AUTH_TOKEN_MISMATCH" },
      });

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {},
      settings,
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(false);
    expect(findVerifiedGatewayListenerPidsOnPortSync.mock.invocationCallOrder[0]).toBeLessThan(
      probeGateway.mock.invocationCallOrder[0] ?? 0,
    );
    expect(probeGateway.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        auth: { token: "test-token" },
        detailLevel: "full",
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a loopback-configured Gateway that is actually listening broadly", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4321, address: "TCP *:18789 (LISTEN)" }],
      hints: [],
    });
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: { mode: "token" },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        connectErrorDetails: { code: "AUTH_TOKEN_MISMATCH" },
      });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(inspectPortUsage).toHaveBeenCalledWith(18789);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a custom-configured Gateway listening on a different address", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    readGatewayProcessArgsSync.mockReturnValue([
      "/usr/bin/node",
      "/app/openclaw.mjs",
      "gateway",
      "run",
      "--bind=custom",
      "--tailscale=off",
    ]);
    resolveGatewayBindHost.mockResolvedValue("192.168.1.10");
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4321, address: "0.0.0.0:18789" }],
      hints: [],
    });
    const customSettings = {
      ...settings,
      bind: "custom" as const,
      customBindHost: "192.168.1.10",
    };
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "custom",
              customBindHost: "192.168.1.10",
              auth: { mode: "token" },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        connectErrorDetails: { code: "AUTH_TOKEN_MISMATCH" },
      });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings: customSettings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(resolveGatewayBindHost).toHaveBeenCalledWith("custom", "192.168.1.10");
    expect(inspectPortUsage).toHaveBeenCalledWith(18789);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a custom bind that resolves away from its configured address", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    readGatewayProcessArgsSync.mockReturnValue([
      "/usr/bin/node",
      "/app/openclaw.mjs",
      "gateway",
      "run",
      "--bind=custom",
      "--tailscale=off",
    ]);
    resolveGatewayBindHost.mockResolvedValue("0.0.0.0");

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings: {
          ...settings,
          bind: "custom",
          customBindHost: "192.168.1.10",
        },
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(resolveGatewayBindHost).toHaveBeenCalledWith("custom", "192.168.1.10");
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes the local TLS fingerprint to every existing Gateway verification probe", async () => {
    loadGatewayTlsRuntime.mockResolvedValueOnce({
      enabled: true,
      required: true,
      fingerprintSha256: "sha256:test-local-gateway",
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: { mode: "token" },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        connectErrorDetails: { code: "AUTH_TOKEN_MISMATCH" },
      });

    const result = await ensureAgentAssistedGatewayRuntime({
      config: { gateway: { tls: { enabled: true } } },
      settings,
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(false);
    expect(loadGatewayTlsRuntime).toHaveBeenCalledWith({ enabled: true });
    expect(probeGateway).toHaveBeenCalledTimes(2);
    for (const [probeOptions] of probeGateway.mock.calls) {
      expect(probeOptions).toEqual(
        expect.objectContaining({
          url: "wss://127.0.0.1:18789",
          tlsFingerprint: "sha256:test-local-gateway",
        }),
      );
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects reuse when the invalid-auth probe fails without an auth rejection", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              auth: { mode: "token" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: false, error: "timeout" });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(probeGateway).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not probe when the verified existing Gateway is replaced before auth", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([4321]).mockReturnValue([9999]);

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects when the verified existing Gateway is replaced during the active auth probe", async () => {
    findVerifiedGatewayListenerPidsOnPortSync
      .mockReturnValueOnce([4321])
      .mockReturnValueOnce([4321])
      .mockReturnValue([9999]);
    probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: {
        path: "/tmp/openclaw.json",
        config: {
          gateway: {
            auth: { mode: "token" },
          },
        },
      },
    });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(probeGateway).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reuses a verified existing Gateway configured without auth", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: {
        path: "/tmp/openclaw.json",
        config: {
          gateway: {
            auth: { mode: "none" },
          },
        },
      },
    });

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {
        gateway: {
          auth: { mode: "none" },
        },
      },
      settings: {
        ...settings,
        authMode: "none",
        gatewayToken: undefined,
      },
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(false);
    expect(probeGateway).toHaveBeenCalledOnce();
    expect(probeGateway.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        auth: {},
        detailLevel: "full",
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reuses a verified existing Gateway whose omitted settings use runtime defaults", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              auth: { mode: "token" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        connectErrorDetails: { code: "AUTH_TOKEN_MISMATCH" },
      });

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {},
      settings,
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["separate bind", ["--bind", "lan"]],
    ["inline bind", ["--bind=lan"]],
    ["separate Tailscale", ["--tailscale", "serve"]],
    ["inline Tailscale", ["--tailscale=serve"]],
  ])("rejects a verified Gateway with a mismatched %s runtime override", async (_name, argv) => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    readGatewayProcessArgsSync.mockReturnValue([
      "/usr/bin/node",
      "/app/openclaw.mjs",
      "gateway",
      "run",
      ...argv,
    ]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: { mode: "token" },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: false });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(readGatewayProcessArgsSync).toHaveBeenCalledWith(4321);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a verified Gateway whose process args can no longer be inspected", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    readGatewayProcessArgsSync.mockReturnValue(null);

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(readGatewayProcessArgsSync).toHaveBeenCalledWith(4321);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a verified Gateway whose listener addresses can no longer be inspected", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    inspectPortUsage.mockRejectedValue(new Error("port inspection unavailable"));

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(inspectPortUsage).toHaveBeenCalledWith(18789);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects existing Gateway reuse when auth enforcement cannot be probed safely", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: {
        path: "/tmp/openclaw.json",
        config: {
          gateway: {
            auth: {
              mode: "token",
              rateLimit: { maxAttempts: 1, exemptLoopback: false },
            },
          },
        },
      },
    });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {
          gateway: {
            auth: {
              mode: "token",
              rateLimit: { maxAttempts: 1, exemptLoopback: false },
            },
          },
        },
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a verified Gateway listener that does not accept the active auth", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(probeGateway).toHaveBeenCalledOnce();
    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(findVerifiedGatewayListenerPidsOnPortSync.mock.invocationCallOrder[0]).toBeLessThan(
      probeGateway.mock.invocationCallOrder[0] ?? 0,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a verified Gateway whose runtime settings do not match", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: {
        path: "/tmp/openclaw.json",
        config: {
          gateway: {
            port: 18789,
            bind: "loopback",
            auth: { mode: "token" },
            tailscale: { mode: "serve" },
          },
        },
      },
    });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(probeGateway).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a verified Gateway whose effective allowTailscale policy does not match", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: { mode: "token", allowTailscale: true },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: false });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: { gateway: { auth: { mode: "token", allowTailscale: false } } },
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable existing trusted-proxy Gateway", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              trustedProxy: { userHeader: "x-forwarded-user" },
            },
          },
        },
        settings: {
          ...settings,
          authMode: "trusted-proxy",
          gatewayToken: undefined,
        },
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a verified trusted-proxy Gateway whose proxy policy does not match", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: {
                mode: "trusted-proxy",
                trustedProxy: {
                  userHeader: "x-forwarded-user",
                  allowLoopback: true,
                },
              },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: false });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              password: "fallback-password",
              trustedProxy: {
                userHeader: "x-forwarded-user",
                allowLoopback: false,
              },
            },
          },
        },
        settings: {
          ...settings,
          authMode: "trusted-proxy",
          gatewayToken: undefined,
        },
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("reuses a verified existing trusted-proxy Gateway with a password fallback", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: {
                mode: "trusted-proxy",
                trustedProxy: { userHeader: "x-forwarded-user" },
              },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        connectErrorDetails: { code: "AUTH_PASSWORD_MISMATCH" },
      });

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            password: "fallback-password",
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        },
      },
      settings: {
        ...settings,
        authMode: "trusted-proxy",
        gatewayToken: undefined,
      },
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(false);
    expect(probeGateway).toHaveBeenCalledTimes(2);
    expect(probeGateway.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ auth: { password: "fallback-password" } }),
    );
    expect(probeGateway.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        auth: { password: expect.stringMatching(/^openclaw-setup-invalid-/) },
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a trusted-proxy Gateway that accepts an invalid fallback password", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: {
                mode: "trusted-proxy",
                trustedProxy: { userHeader: "x-forwarded-user" },
              },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              password: "fallback-password",
              trustedProxy: { userHeader: "x-forwarded-user" },
            },
          },
        },
        settings: {
          ...settings,
          authMode: "trusted-proxy",
          gatewayToken: undefined,
        },
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(probeGateway).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects trusted-proxy assisted setup without a local password fallback", async () => {
    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              trustedProxy: { userHeader: "x-forwarded-user" },
            },
          },
        },
        settings: {
          ...settings,
          authMode: "trusted-proxy",
          gatewayToken: undefined,
        },
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("requires gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("probes a temporary trusted-proxy Gateway through its password fallback", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "fallback-password");
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: matchingGatewayConfigSnapshot({
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-forwarded-user" },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        connectErrorDetails: { code: "AUTH_PASSWORD_MISMATCH" },
      });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValue([4321]);

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        },
      },
      settings: {
        ...settings,
        authMode: "trusted-proxy",
        gatewayToken: undefined,
      },
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(true);
    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenLastCalledWith(18789);
    expect(probeGateway).toHaveBeenCalledTimes(2);
    expect(probeGateway.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        auth: { password: "fallback-password" },
        detailLevel: "full",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(probeGateway.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        auth: { password: expect.stringMatching(/^openclaw-setup-invalid-/) },
        detailLevel: "none",
        signal: expect.any(AbortSignal),
      }),
    );

    const stop = result.stop();
    child.emit("exit", 0, null);
    await stop;
  });

  it("rejects a temporary trusted-proxy Gateway that exits after binding", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockImplementationOnce(() => {
      child.exitCode = 1;
      return [4321];
    });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              password: "fallback-password",
              trustedProxy: { userHeader: "x-forwarded-user" },
            },
          },
        },
        settings: {
          ...settings,
          authMode: "trusted-proxy",
          gatewayToken: undefined,
        },
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("Unable to start Gateway for assisted setup");

    expect(probeGateway).not.toHaveBeenCalled();
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("aborts temporary Gateway readiness when the owned listener exits during the probe", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValue([4321]);
    let probeSignal: AbortSignal | undefined;
    probeGateway.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      probeSignal = signal;
      child.exitCode = 1;
      child.emit("exit", 1, null);
      return { ok: true };
    });
    const prompter = createWizardPrompter();

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter,
      }),
    ).rejects.toThrow("Unable to start Gateway for assisted setup");

    expect(probeSignal?.aborted).toBe(true);
    expect(prompter.note).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("stops waiting when the temporary Gateway exits before binding", async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      spawn.mockReturnValueOnce(child);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockImplementation(() => {
        child.exitCode = 1;
        return [];
      });

      let settled = false;
      const result = ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(200);
      const settledAfterExit = settled;
      await vi.runAllTimersAsync();

      expect(settledAfterExit).toBe(true);
      await expect(result).resolves.toEqual(
        expect.objectContaining({
          message: expect.stringContaining("exited before listening"),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a temporary Gateway when none is reachable", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: matchingGatewayConfigSnapshot(),
      })
      .mockResolvedValueOnce({
        ok: false,
        connectErrorDetails: { code: "AUTH_TOKEN_MISMATCH" },
      });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValue([4321]);
    const prompter = createWizardPrompter();

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {},
      settings,
      prompter,
    });

    expect(result.temporary).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/app/openclaw.mjs", "gateway", "--port", "18789"],
      expect.objectContaining({
        cwd: "/app",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(prompter.note).toHaveBeenCalled();
    expect(probeGateway).toHaveBeenCalledTimes(2);
    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledTimes(5);
    expect(findVerifiedGatewayListenerPidsOnPortSync.mock.invocationCallOrder[2]).toBeLessThan(
      probeGateway.mock.invocationCallOrder[0] ?? 0,
    );

    const stop = result.stop();
    child.emit("exit", 0, null);
    await stop;

    expect(killProcessTree).toHaveBeenCalledWith(4321, {
      detached: process.platform !== "win32",
      graceMs: 1500,
    });
    expect(detach).toHaveBeenCalledOnce();
  });

  it("rejects a temporary Gateway that accepts invalid token auth", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/ambient-openclaw-state");
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: matchingGatewayConfigSnapshot(),
      })
      .mockResolvedValueOnce({ ok: true });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValue([4321]);
    killProcessTree.mockImplementationOnce(() => queueMicrotask(() => child.emit("exit", 0, null)));

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("Unable to start Gateway for assisted setup");

    expect(probeGateway).toHaveBeenCalledTimes(2);
    const activeProbe = probeGateway.mock.calls[0]?.[0];
    const invalidProbe = probeGateway.mock.calls[1]?.[0];
    expect(activeProbe).toEqual(
      expect.objectContaining({
        auth: { token: "test-token" },
        detailLevel: "full",
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: expect.stringContaining("openclaw-setup-gateway-probe-"),
        }),
      }),
    );
    expect(invalidProbe).toEqual(
      expect.objectContaining({
        auth: { token: expect.stringMatching(/^openclaw-setup-invalid-/) },
        detailLevel: "none",
        env: activeProbe?.env,
      }),
    );
    expect(activeProbe?.env.OPENCLAW_STATE_DIR).not.toBe("/tmp/ambient-openclaw-state");
    expect(killProcessTree).toHaveBeenCalledWith(4321, {
      detached: process.platform !== "win32",
      graceMs: 1500,
    });
    expect(detach).toHaveBeenCalledOnce();
  });

  it("does not probe a temporary Gateway when another process owns the probe address", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    probeGateway.mockResolvedValueOnce({ ok: true });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValue([4321]);
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [
        { pid: 9999, address: "127.0.0.1:18789" },
        { pid: 4321, address: "[::1]:18789" },
      ],
      hints: [],
    });
    killProcessTree.mockImplementationOnce(() => queueMicrotask(() => child.emit("exit", 0, null)));

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("Unable to start Gateway for assisted setup");

    expect(inspectPortUsage).toHaveBeenCalledWith(18789);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(killProcessTree).toHaveBeenCalledWith(4321, {
      detached: process.platform !== "win32",
      graceMs: 1500,
    });
  });

  it("passes the local TLS fingerprint to temporary Gateway readiness probes", async () => {
    loadGatewayTlsRuntime.mockResolvedValueOnce({
      enabled: true,
      required: true,
      fingerprintSha256: "sha256:test-local-gateway",
    });
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: matchingGatewayConfigSnapshot(),
      })
      .mockResolvedValueOnce({
        ok: false,
        connectErrorDetails: { code: "AUTH_TOKEN_MISMATCH" },
      });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValue([4321]);

    const result = await ensureAgentAssistedGatewayRuntime({
      config: { gateway: { tls: { enabled: true } } },
      settings,
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(true);
    expect(loadGatewayTlsRuntime).toHaveBeenCalledWith({ enabled: true });
    expect(probeGateway).toHaveBeenCalledTimes(2);
    for (const [probeOptions] of probeGateway.mock.calls) {
      expect(probeOptions).toEqual(
        expect.objectContaining({
          url: "wss://127.0.0.1:18789",
          tlsFingerprint: "sha256:test-local-gateway",
        }),
      );
    }

    const stop = result.stop();
    child.emit("exit", 0, null);
    await stop;
  });

  it("surfaces child spawn failures before probing Gateway readiness", async () => {
    const child = createMockChild();
    child.pid = undefined;
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("Unable to start Gateway for assisted setup: spawn ENOENT");

    expect(probeGateway).not.toHaveBeenCalled();
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it("stops the temporary Gateway when post-spawn setup fails", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: matchingGatewayConfigSnapshot(),
      })
      .mockResolvedValueOnce({
        ok: false,
        connectErrorDetails: { code: "AUTH_TOKEN_MISMATCH" },
      });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValue([4321]);
    killProcessTree.mockImplementationOnce(() => queueMicrotask(() => child.emit("exit", 0, null)));
    const prompter = createWizardPrompter({
      note: vi.fn(async () => {
        throw new Error("note failed");
      }),
    });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter,
      }),
    ).rejects.toThrow("note failed");

    expect(killProcessTree).toHaveBeenCalledWith(4321, {
      detached: process.platform !== "win32",
      graceMs: 1500,
    });
    expect(detach).toHaveBeenCalledOnce();
  });
});
