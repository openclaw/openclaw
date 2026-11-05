import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
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
} from "./internal-hooks.js";
import { emitSessionAutoResetHook } from "./session-auto-reset.js";

const logs = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), verbose: vi.fn() }));

vi.mock("../globals.js", () => ({ logVerbose: logs.verbose }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => logs }));

function reset() {
  clearInternalHooks();
  resetGatewayWorkAdmission();
}
beforeEach(() => {
  reset();
  setInternalHooksEnabled(true);
  vi.clearAllMocks();
});
afterEach(reset);

it("keeps reset work alive past requester closure and hook errors", async ({ signal }) => {
  const parent = new AsyncWorkScope();
  const root = tryBeginGatewayRootWorkAdmission("test:auto-reset");
  assert(root, "Expected parent root admission");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const trailing = vi.fn();
  const effect = vi.fn();
  registerInternalHook("session:auto-reset", async () => {
    entered.resolve();
    await release.promise;
    await trackAsyncWork(() => {
      effect();
      throw new Error("synthetic hook failure");
    });
  });
  registerInternalHook("session:auto-reset", async () => {
    trailing();
  });
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
    await withinTest(parent.drain(), signal);
    expect(parent.isClosing).toBe(true);
    expect(effect).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
  } finally {
    release.resolve();
    root.release();
    await parent.drain();
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), {
      timeout: 2_000,
      interval: 10,
    });
  }
  expect(trailing).toHaveBeenCalledExactlyOnceWith();
  expect(effect).toHaveBeenCalledExactlyOnceWith();
  expect(logs.error).toHaveBeenCalledExactlyOnceWith(
    "Hook error [session:auto-reset]: synthetic hook failure",
  );
  expect(logs.verbose).not.toHaveBeenCalled();
});
