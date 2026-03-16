import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PreparedSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createGatewaySecretsActivationController } from "./server-startup-secrets.js";

function createPreparedSnapshot(config: OpenClawConfig): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: config,
    config,
    authStores: [],
    warnings: [],
    webTools: {
      search: {
        providerSource: "none",
        diagnostics: [],
      },
      fetch: {
        firecrawl: {
          active: false,
          apiKeySource: "missing",
          diagnostics: [],
        },
      },
      diagnostics: [],
    },
  };
}

describe("createGatewaySecretsActivationController", () => {
  it("wraps startup failures with startup-specific context", async () => {
    const emitStateEvent = vi.fn();
    const log = {
      info: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    };
    const controller = createGatewaySecretsActivationController({
      prepareSecretsRuntimeSnapshot: vi.fn().mockRejectedValue(new Error("boom")),
      activateRuntimeSnapshot: vi.fn(),
      onAuthSurfaceDiagnostics: vi.fn(),
      log,
      emitStateEvent,
    });

    await expect(
      controller.activateRuntimeSecrets({}, { reason: "startup", activate: false }),
    ).rejects.toThrow("Startup failed: required secrets are unavailable. Error: boom");

    expect(log.error).toHaveBeenCalledWith("[SECRETS_RELOADER_DEGRADED] Error: boom");
    expect(emitStateEvent).not.toHaveBeenCalled();
  });

  it("emits degraded only once across repeated non-startup failures", async () => {
    const emitStateEvent = vi.fn();
    const log = {
      info: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    };
    const controller = createGatewaySecretsActivationController({
      prepareSecretsRuntimeSnapshot: vi
        .fn()
        .mockRejectedValueOnce(new Error("first"))
        .mockRejectedValueOnce(new Error("second")),
      activateRuntimeSnapshot: vi.fn(),
      onAuthSurfaceDiagnostics: vi.fn(),
      log,
      emitStateEvent,
    });

    await expect(
      controller.activateRuntimeSecrets({}, { reason: "reload", activate: true }),
    ).rejects.toThrow("first");
    await expect(
      controller.activateRuntimeSecrets({}, { reason: "reload", activate: true }),
    ).rejects.toThrow("second");

    expect(emitStateEvent).toHaveBeenCalledTimes(1);
    expect(emitStateEvent).toHaveBeenCalledWith(
      "SECRETS_RELOADER_DEGRADED",
      expect.stringContaining("runtime remains on last-known-good snapshot"),
      {},
    );
    expect(log.error).toHaveBeenCalledWith("[SECRETS_RELOADER_DEGRADED] Error: first");
    expect(log.warn).toHaveBeenCalledWith("[SECRETS_RELOADER_DEGRADED] Error: second");
  });

  it("emits recovered after a degraded period and activates snapshots when requested", async () => {
    const emitStateEvent = vi.fn();
    const activateRuntimeSnapshot = vi.fn<(snapshot: PreparedSecretsRuntimeSnapshot) => void>();
    const onAuthSurfaceDiagnostics = vi.fn<(snapshot: PreparedSecretsRuntimeSnapshot) => void>();
    const log = {
      info: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    };
    const recoveredConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "abc123" } },
    };
    const recoveredPrepared = createPreparedSnapshot(recoveredConfig);
    recoveredPrepared.warnings = [
      {
        code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
        path: "gateway.auth.token",
        message: "warning",
      },
    ];
    const controller = createGatewaySecretsActivationController({
      prepareSecretsRuntimeSnapshot: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(recoveredPrepared),
      activateRuntimeSnapshot,
      onAuthSurfaceDiagnostics,
      log,
      emitStateEvent,
    });

    await expect(
      controller.activateRuntimeSecrets({}, { reason: "reload", activate: true }),
    ).rejects.toThrow("offline");
    await expect(
      controller.activateRuntimeSecrets(recoveredConfig, { reason: "reload", activate: true }),
    ).resolves.toBe(recoveredPrepared);

    expect(activateRuntimeSnapshot).toHaveBeenCalledWith(recoveredPrepared);
    expect(onAuthSurfaceDiagnostics).toHaveBeenCalledWith(recoveredPrepared);
    expect(log.warn).toHaveBeenCalledWith("[SECRETS_REF_OVERRIDES_PLAINTEXT] warning");
    expect(log.info).toHaveBeenCalledWith(
      "[SECRETS_RELOADER_RECOVERED] Secret resolution recovered; runtime remained on last-known-good during the outage.",
    );
    expect(emitStateEvent).toHaveBeenNthCalledWith(
      1,
      "SECRETS_RELOADER_DEGRADED",
      expect.stringContaining("runtime remains on last-known-good snapshot"),
      {},
    );
    expect(emitStateEvent).toHaveBeenNthCalledWith(
      2,
      "SECRETS_RELOADER_RECOVERED",
      "Secret resolution recovered; runtime remained on last-known-good during the outage.",
      recoveredConfig,
    );
  });

  it("serializes activation runs with the controller lock", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const callOrder: string[] = [];
    const controller = createGatewaySecretsActivationController({
      prepareSecretsRuntimeSnapshot: vi.fn(async ({ config }) => {
        const callNumber = callOrder.filter((item) => item.startsWith("start")).length;
        callOrder.push(`start-${callNumber}`);
        if (callNumber === 0) {
          await firstReady;
        }
        callOrder.push(`end-${callNumber}`);
        return createPreparedSnapshot(config);
      }),
      activateRuntimeSnapshot: vi.fn(),
      onAuthSurfaceDiagnostics: vi.fn(),
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      emitStateEvent: vi.fn(),
    });

    const first = controller.activateRuntimeSecrets({}, { reason: "reload", activate: false });
    const second = controller.activateRuntimeSecrets({}, { reason: "reload", activate: false });
    await Promise.resolve();
    expect(callOrder).toEqual(["start-0"]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(callOrder).toEqual(["start-0", "end-0", "start-1", "end-1"]);
  });
});
