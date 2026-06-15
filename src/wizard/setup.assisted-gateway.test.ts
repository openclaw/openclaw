import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { ensureAgentAssistedGatewayRuntime } from "./setup.assisted-gateway.js";

const spawn = vi.hoisted(() => vi.fn());
const waitForGatewayReachable = vi.hoisted(() => vi.fn());
const probeGateway = vi.hoisted(() => vi.fn());
const resolveGatewayProgramArguments = vi.hoisted(() => vi.fn());
const killProcessTree = vi.hoisted(() => vi.fn());
const detach = vi.hoisted(() => vi.fn());
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() => vi.fn(() => [] as number[]));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  resolveControlUiLinks: () => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  }),
  waitForGatewayReachable,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway,
}));

vi.mock("../config/paths.js", () => ({
  resolveConfigPath: () => "/tmp/openclaw.json",
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree,
}));

vi.mock("../process/child-process-bridge.js", () => ({
  attachChildProcessBridge: () => ({ detach }),
}));

vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync,
}));

vi.mock("./setup.secret-input.js", () => ({
  resolveSetupSecretInputString: vi.fn(async () => "test-password"),
}));

type MockChild = EventEmitter & {
  pid: number;
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
    probeGateway.mockResolvedValue({ ok: false });
    resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["/usr/bin/node", "/app/openclaw.mjs", "gateway", "--port", "18789"],
      workingDirectory: "/app",
    });
  });

  it("reuses an already reachable Gateway", async () => {
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
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: false });

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {},
      settings,
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(waitForGatewayReachable).not.toHaveBeenCalled();
  });

  it("rejects a reachable Gateway whose runtime auth does not match the active config", async () => {
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
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active config and auth mode");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable existing trusted-proxy Gateway", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([4321]);

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
    ).rejects.toThrow("cannot verify that it matches the active config and auth mode");

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts only the temporary trusted-proxy Gateway listener it started", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    waitForGatewayReachable.mockResolvedValueOnce({ ok: false, detail: "trusted proxy required" });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValueOnce([4321]);

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

    const stop = result.stop();
    child.emit("exit", 0, null);
    await stop;
  });

  it("runs a temporary Gateway when none is reachable", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    waitForGatewayReachable.mockResolvedValueOnce({ ok: true });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]);
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

    const stop = result.stop();
    child.emit("exit", 0, null);
    await stop;

    expect(killProcessTree).toHaveBeenCalledWith(4321, {
      detached: process.platform !== "win32",
      graceMs: 1500,
    });
    expect(detach).toHaveBeenCalledOnce();
  });

  it("does not require listener discovery after the temporary Gateway responds", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    waitForGatewayReachable.mockResolvedValueOnce({ ok: true });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {},
      settings,
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(true);
    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledOnce();

    const stop = result.stop();
    child.emit("exit", 0, null);
    await stop;
  });
});
