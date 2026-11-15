import { expect, it, vi } from "vitest";
import { markEmbeddedRunAuthProfileSuccess } from "../agents/embedded-agent-runner/run/auth-profile-success.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";

const auth = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("../agents/auth-profiles.js", () => ({ markAuthProfileSuccess: auth.success }));

it.each([false, true])(
  "settles deferred auth bookkeeping before retiring repair resources (failure=%s)",
  async (fails) => {
    const pending = createDeferredCore();
    auth.success.mockReturnValueOnce(pending.promise);
    const resources = createOpenClawDatabaseMaintenanceScope();
    const retired = vi.fn();
    resources.own({}, "agent-handles", retired);
    const result = resources.run(() =>
      markEmbeddedRunAuthProfileSuccess({
        profileId: "fixture:repair",
        profileStore: { version: 1, profiles: {} },
        provider: "fixture",
        runId: "fixture-run",
        sessionId: "fixture-session",
      }),
    );
    expect(result).toBeUndefined();
    const closed = resources.close();
    try {
      expect(retired).not.toHaveBeenCalled();
    } finally {
      if (fails) {
        pending.reject(new Error("synthetic bookkeeping refusal"));
      } else {
        pending.resolve();
      }
      await closed;
    }
    expect(retired).toHaveBeenCalledOnce();
  },
);
