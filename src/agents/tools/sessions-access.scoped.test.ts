import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityChecker,
} from "../../plugin-sdk/session-visibility.js";
import { resolveSessionToolAccess } from "./sessions-access.js";

describe("resolveSessionToolAccess scoped providers", () => {
  it.each(["grant", "unregister", "empty", "blank", "reject"] as const)(
    "awaits the scoped provider's %s outcome at the session-tool boundary",
    async (outcome) => {
      const requesterSessionKey = "agent:main:requester";
      const authorizationTargetSessionKey = "agent:ops:shared";
      const pending = createDeferred<{ expectedSessionId: string } | undefined>();
      const syncProvider = vi.fn(() => ({ expectedSessionId: "sync-incarnation" }));
      const asyncProvider = vi.fn(() => pending.promise);
      const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(syncProvider, {
        resolveAsync: asyncProvider,
      });
      try {
        const access = resolveSessionToolAccess({
          action: "history",
          requesterAgentId: "main",
          requesterSessionKey,
          authorizationTargetSessionKey,
          targetAgentId: "ops",
          targetSessionKey: "shared",
          requesterOwned: false,
          visibility: "self",
          a2aPolicy: createAgentToAgentPolicy({}),
        });
        if (outcome === "unregister") {
          unregister();
        }
        if (outcome === "reject") {
          pending.reject(new Error("provider unavailable"));
        } else {
          pending.resolve(
            outcome === "empty"
              ? undefined
              : {
                  expectedSessionId: outcome === "blank" ? " " : "async-incarnation",
                },
          );
        }
        if (outcome === "grant") {
          await expect(access).resolves.toEqual({
            allowed: true,
            expectedSessionId: "async-incarnation",
          });
        } else {
          await expect(access).resolves.toMatchObject({
            allowed: false,
            reasonCode: "cross_agent_visibility_restricted",
          });
        }
        expect(asyncProvider).toHaveBeenCalledWith({
          action: "history",
          requesterSessionKey,
          targetSessionKey: authorizationTargetSessionKey,
        });
        expect(syncProvider).not.toHaveBeenCalled();
      } finally {
        unregister();
      }
    },
  );
});
