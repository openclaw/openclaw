import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  clearInternalHooks,
  registerInternalHook,
  setInternalHooksEnabled,
  unregisterInternalHook,
  type InternalHookHandler,
} from "./internal-hooks.js";
import { emitSessionAutoResetHook } from "./session-auto-reset.js";

const logs = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), verbose: vi.fn() }));

// Only environment discovery, diagnostic formatting, logging, and legacy plugin adapters are replaced.
// The emitter, hook registry/dispatch, admission owner, and async scope are real.
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/synthetic/workspace",
  resolveSessionAgentId: () => "main",
}));
vi.mock("../config/sessions/legacy-sqlite-marker.js", () => ({
  parseSqliteSessionFileMarker: () => undefined,
}));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/synthetic/store",
}));
vi.mock("../infra/errors.js", () => ({
  formatErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("../globals.js", () => ({ logVerbose: logs.verbose }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => logs }));
vi.mock("../plugins/legacy-internal-hook-state.js", () => ({
  clearLegacyPluginInternalHooks: () => {},
  listLegacyPluginInternalHookEventKeys: () => [],
  listLegacyPluginInternalHooks: () => [],
}));

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(() => {
  clearInternalHooks();
  setInternalHooksEnabled(true);
  resetGatewayWorkAdmission();
  vi.clearAllMocks();
});

afterEach(() => {
  clearInternalHooks();
  resetGatewayWorkAdmission();
});

describe("automatic reset hook lifetime", () => {
  async function exercise(options: { parent: boolean; throws?: boolean }) {
    const parent = options.parent ? new AsyncWorkScope() : undefined;
    const root = options.parent ? tryBeginGatewayRootWorkAdmission("test:auto-reset") : undefined;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const finished = createDeferredCore();
    const trailing = vi.fn();
    const effect = vi.fn();
    let started = false;
    const handler: InternalHookHandler = async () => {
      started = true;
      entered.resolve();
      try {
        await release.promise;
        await trackAsyncWork(() => {
          effect();
          if (options.throws) {
            throw new Error("synthetic hook failure");
          }
        });
      } finally {
        finished.resolve();
      }
    };
    const trailingHandler: InternalHookHandler = async () => {
      trailing();
    };
    registerInternalHook("session:auto-reset", handler);
    registerInternalHook("session:auto-reset", trailingHandler);
    const emit = () =>
      emitSessionAutoResetHook({
        cfg: {},
        sessionId: "synthetic-session",
        sessionKey: "agent:main:synthetic",
        reason: "daily",
        agentId: "main",
        workspaceDir: "/synthetic/workspace",
        storePath: "/synthetic/store",
      });

    try {
      if (parent) {
        if (!root) {
          throw new Error("Expected parent root admission");
        }
        await root.run(async () => parent.run(emit));
      } else {
        emit();
      }
      await within(entered.promise, "hook entry");
      root?.release();
      if (parent) {
        // The barrier deliberately keeps the hook pending until its requester
        // has fully drained. No elapsed-time race decides the ordering.
        await within(parent.drain(), "requester closure");
        expect(parent.isClosing).toBe(true);
      }
      expect(effect).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      release.resolve();
      await within(finished.promise, "delayed hook completion");
      await vi.waitFor(
        () => {
          expect(trailing).toHaveBeenCalledExactlyOnceWith();
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        },
        { timeout: 2_000, interval: 10 },
      );
      expect(effect).toHaveBeenCalledExactlyOnceWith();
      if (options.throws) {
        expect(logs.error).toHaveBeenCalledExactlyOnceWith(
          "Hook error [session:auto-reset]: synthetic hook failure",
        );
      } else {
        expect(logs.error).not.toHaveBeenCalled();
      }
      expect(logs.verbose).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      root?.release();
      try {
        if (started) {
          await within(finished.promise, "hook cleanup");
        }
        if (parent) {
          await within(parent.drain(), "requester cleanup");
        }
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), {
          timeout: 2_000,
          interval: 10,
        });
      } finally {
        unregisterInternalHook("session:auto-reset", handler);
        unregisterInternalHook("session:auto-reset", trailingHandler);
      }
    }
  }

  it("completes delayed tracked work after the triggering requester closes", async () => {
    await exercise({ parent: true });
  });

  it("owns and releases delayed hook work when there is no parent request", async () => {
    await exercise({ parent: false });
  });

  it("releases work and continues dispatch when a delayed hook throws", async () => {
    await exercise({ parent: true, throws: true });
  });
});
