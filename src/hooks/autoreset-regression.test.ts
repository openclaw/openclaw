import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
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

it("releases delayed hook work and continues dispatch after requester closure and a hook error", async ({
  signal,
}) => {
  const parent = new AsyncWorkScope();
  const root = tryBeginGatewayRootWorkAdmission("test:auto-reset");
  if (!root) {
    throw new Error("Expected parent root admission");
  }
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const trailing = vi.fn();
  const effect = vi.fn();
  const handler: InternalHookHandler = async () => {
    entered.resolve();
    await release.promise;
    await trackAsyncWork(() => {
      effect();
      throw new Error("synthetic hook failure");
    });
  };
  const trailingHandler: InternalHookHandler = async () => {
    trailing();
  };
  registerInternalHook("session:auto-reset", handler);
  registerInternalHook("session:auto-reset", trailingHandler);
  try {
    await root.run(async () =>
      parent.run(() =>
        emitSessionAutoResetHook({
          cfg: {},
          sessionId: "synthetic-session",
          sessionKey: "agent:main:synthetic",
          reason: "daily",
          agentId: "main",
          workspaceDir: "/synthetic/workspace",
          storePath: "/synthetic/store",
        }),
      ),
    );
    await withinTest(entered.promise, signal);
    root.release();
    // Keep the hook pending until its requester has fully drained.
    await withinTest(parent.drain(), signal);
    expect(parent.isClosing).toBe(true);
    expect(effect).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
  } finally {
    release.resolve();
    root.release();
    try {
      await parent.drain();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), {
        timeout: 2_000,
        interval: 10,
      });
    } finally {
      unregisterInternalHook("session:auto-reset", handler);
      unregisterInternalHook("session:auto-reset", trailingHandler);
    }
  }
  expect(trailing).toHaveBeenCalledExactlyOnceWith();
  expect(effect).toHaveBeenCalledExactlyOnceWith();
  expect(logs.error).toHaveBeenCalledExactlyOnceWith(
    "Hook error [session:auto-reset]: synthetic hook failure",
  );
  expect(logs.verbose).not.toHaveBeenCalled();
});
