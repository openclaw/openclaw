import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import * as delivery from "../agents/tools/sessions-send-tool.delivery.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  drainSessionToolsFixture,
  withSessionToolsFixture,
} from "./local-request-context.session-tools.test-support.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import * as sessionRowProjection from "./session-row-projection.js";
import { roleClient } from "./session-sharing.test-utils.js";

const REQUESTER = "agent:main:dashboard:notify-parent";
const TARGET = "agent:main:dashboard:notify-child";
const FOREIGN = "agent:main:dashboard:notify-foreign";

async function withSlowProjectionStartup(run: () => Promise<void>) {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const createProjection = sessionRowProjection.createSessionRowProjection;
  const prepare = vi
    .spyOn(sessionRowProjection, "createSessionRowProjection")
    .mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return createProjection(...args);
    });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = run();
  void pending.catch(() => {});
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "Notification settled before projection startup",
    );
    // Slow fixture initialization must not spend the real router's 10-second request budget.
    await vi.advanceTimersByTimeAsync(10_001);
    vi.useRealTimers();
    resume.resolve();
    await pending;
  } finally {
    vi.useRealTimers();
    resume.resolve();
    await pending.catch(() => {});
    prepare.mockRestore();
  }
}

async function withNotification(
  scope: "operator.sessions.write" | "operator.write",
  run: (fixture: {
    notify: (
      sessionKey?: string,
    ) => ReturnType<ReturnType<typeof createSessionsSendTool>["execute"]>;
    revoke: () => void;
    changeRole: () => void;
    deleteTarget: () => Promise<void>;
  }) => Promise<void>,
) {
  await withSessionToolsFixture(async (cfg) => {
    const role = expectDefined(cfg.gateway?.roles?.definitions?.view, "guest role");
    role.scopes = [scope];
    role.sandbox = "required";
    const client = roleClient("view", "notification-owner");
    client.connect.scopes = [scope];
    const profileId = expectDefined(
      client.authenticatedUserProfile,
      "notification person",
    ).profileId;
    for (const [sessionKey, sessionId, creatorId] of [
      [REQUESTER, "notify-parent-session", profileId],
      [TARGET, "notify-child-session", profileId],
      [FOREIGN, "notify-foreign-session", "another-person"],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: 1,
          visibility: "shared",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: creatorId },
          sandbox: "required",
          ...(sessionKey !== REQUESTER ? { spawnedBy: REQUESTER } : {}),
        },
      );
    }
    const context = expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "Gateway");
    const source = new AbortController();
    const captured = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: source.signal,
          assertCurrent: () => source.signal.throwIfAborted(),
        },
      }),
      "original operator source",
    );
    try {
      await withPersonalToolTurn(
        {
          owner: {
            profileId,
            senderId: "notification-owner",
            name: "Notification owner",
            operatorAuthority: captured.authority,
          },
          sessionKey: REQUESTER,
          sessionId: "notify-parent-session",
        },
        async () => {
          const tool = createSessionsSendTool({ config: cfg, agentSessionKey: REQUESTER });
          await run({
            notify: (sessionKey = TARGET) =>
              tool.execute("notify-child", {
                sessionKey,
                mode: "notify",
                message: "Inspect the prepared change.",
              }),
            revoke: () => source.abort(new Error("notification source revoked")),
            changeRole: () => {
              role.scopes = ["operator.sessions.read"];
            },
            deleteTarget: async () => {
              const removed = await deleteSessionEntryLifecycle({
                agentId: "main",
                storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
                target: { canonicalKey: TARGET, storeKeys: [TARGET] },
                archiveTranscript: false,
                deleteTranscriptWithoutArchive: true,
              });
              expect(removed).toMatchObject({
                deleted: true,
                deletedSessionId: "notify-child-session",
              });
            },
          });
        },
      );
    } finally {
      captured.release();
      drainSystemEvents(TARGET);
      drainSystemEvents(FOREIGN);
      drainSystemEvents(REQUESTER);
    }
  });
}

describe("session notification authority", () => {
  afterEach(drainSessionToolsFixture);

  it.each([
    ["operator.sessions.write", TARGET, true],
    ["operator.write", TARGET, true],
    ["operator.sessions.write", FOREIGN, false],
  ] as const)(
    "authorizes %s notification to %s (allowed: %s)",
    async (scope, sessionKey, allowed) => {
      await withSlowProjectionStartup(() =>
        withNotification(scope, async ({ notify, revoke }) => {
          if (!allowed) {
            await expect(notify(sessionKey)).rejects.toThrow(/own session|not allowed/);
            expect(drainSystemEvents(sessionKey)).toEqual([]);
            return;
          }
          await expect(notify(sessionKey)).resolves.toMatchObject({
            details: {
              status: "queued",
              sessionKey: TARGET,
              notificationId: expect.any(String),
              durability: "process",
              runStarted: false,
            },
          });
          revoke();
          expect(drainSystemEvents(TARGET)).toEqual([
            expect.stringContaining("Inspect the prepared change."),
          ]);
          expect(drainSystemEvents(REQUESTER)).toEqual([]);
        }),
      );
    },
  );

  it.each(["source revoked", "role changed", "target deleted"] as const)(
    "cannot queue when %s during notification authorization",
    async (change) => {
      await withNotification(
        "operator.sessions.write",
        async ({ notify, revoke, changeRole, deleteTarget }) => {
          const context = expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "Gateway");
          const entered = createDeferredCore();
          const resume = createDeferredCore();
          const prepare = context.ensureSessionRowProjection;
          const originalNotify = delivery.notifySessionsSendSession;
          const spy = vi
            .spyOn(delivery, "notifySessionsSendSession")
            .mockImplementationOnce((params) => {
              // Pause the real router after tool visibility checks, before mutation admission.
              context.ensureSessionRowProjection = async () => {
                await prepare?.();
                entered.resolve();
                await resume.promise;
              };
              return originalNotify(params);
            });
          const pending = notify();
          void pending.catch(() => {});
          try {
            await awaitGateBeforeSettlement(
              entered.promise,
              pending,
              "Notification settled before mutation admission",
            );
            expect(spy).toHaveBeenCalledOnce();
            if (change === "source revoked") {
              revoke();
            } else if (change === "role changed") {
              changeRole();
            } else {
              await deleteTarget();
            }
            resume.resolve();
            await expect(pending).rejects.toThrow(
              change === "source revoked"
                ? /notification source revoked/
                : change === "role changed"
                  ? /operator role changed/
                  : /session target is unavailable/i,
            );
          } finally {
            resume.resolve();
            await pending.catch(() => {});
            context.ensureSessionRowProjection = prepare;
            spy.mockRestore();
          }
          expect(drainSystemEvents(TARGET)).toEqual([]);
        },
      );
    },
  );
});
