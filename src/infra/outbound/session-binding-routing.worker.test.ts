import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observeParentSqlite,
  sqliteMethods as methods,
  emptySqliteCounts as emptyCounts,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveBoundAcpDispatchSessionKey } from "../../auto-reply/reply/dispatch-from-config.context.js";
import { resolveIngressFailureDisposition } from "../../channels/message/ingress-retry-policy.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { buildChannelInboundEventContext } from "../../plugin-sdk/channel-inbound.js";
import {
  getSessionBindingService,
  resolveRuntimeConversationBindingRouteAsync,
} from "../../plugin-sdk/conversation-binding-runtime.js";
import {
  createAccountScopedConversationBindingManager,
  resetAccountScopedConversationBindingsForTests,
} from "../../plugin-sdk/thread-bindings-runtime.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { inspectCurrentConversationBindingRecord } from "./current-conversation-bindings.js";
import {
  readSessionBindingSelectionCurrent,
  registerSessionBindingAdapter,
  testing,
  type SessionBindingRecord,
} from "./session-binding-service.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const stateKey = Symbol("binding-routing-worker-proof");
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-binding-route-worker-"));
  testing.resetSessionBindingAdaptersForTests();
});
afterEach(async () => {
  resetAccountScopedConversationBindingsForTests({ stateKey });
  testing.resetSessionBindingAdaptersForTests();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

describe("awaited conversation routing storage ownership", () => {
  it.each(["generic", "account"] as const)(
    "routes and records activity for %s bindings without parent SQLite calls",
    async (kind) => {
      const channel = kind === "generic" ? "webchat" : "imessage";
      const conversation = { channel, accountId: "default", conversationId: "worker-route" };
      const service = getSessionBindingService();
      const route: ResolvedAgentRoute = {
        agentId: "main",
        channel,
        accountId: "default",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "main",
        matchedBy: "default",
      };
      const observer = observeParentSqlite();
      let manager: ReturnType<typeof createAccountScopedConversationBindingManager> | undefined;
      try {
        const calibration = openNodeSqliteDatabase(":memory:");
        calibration.exec("CREATE TABLE calibration (value INTEGER)");
        calibration.prepare("INSERT INTO calibration VALUES (?)").run(7);
        const query = calibration.prepare("SELECT value FROM calibration");
        expect(query.get()).toEqual({ value: 7 });
        expect(query.all()).toEqual([{ value: 7 }]);
        expect([...query.iterate()]).toEqual([{ value: 7 }]);
        calibration.close();
        for (const method of methods) {
          expect(observer.counts[method], `${method} calibration`).toBeGreaterThan(0);
        }
        observer.reset();
        if (kind === "account") {
          manager = createAccountScopedConversationBindingManager({
            channel,
            accountId: "default",
            cfg: { session: { threadBindings: { idleHours: 1, maxAgeHours: 0 } } },
            stateKey,
            toStoredTargetKind: (targetKind) => targetKind,
            toSessionBindingTargetKind: (targetKind) => targetKind,
          });
        }
        const binding = await service.bind({
          conversation,
          targetSessionKey: "agent:target:main",
          targetKind: "session",
        });
        expect(observer.counts.run, "fixture binding writes are observable").toBeGreaterThan(0);
        observer.reset();
        const result = await resolveRuntimeConversationBindingRouteAsync({ route, conversation });
        expect(result.bindingRecord?.bindingId).toBe(binding.bindingId);
        expect(result.route.sessionKey).toBe(binding.targetSessionKey);
        expect(result.bindingOwnerAvailable).toBe(true);
        const selection = await readSessionBindingSelectionCurrent([
          { ...conversation, conversationId: "missing" },
          {
            ...conversation,
            accountId: " DEFAULT ",
            conversationId: " worker-route ",
            parentConversationId: kind === "account" ? "account-ignored-parent" : undefined,
          },
        ]);
        expect(selection[0]).toBeNull();
        expect(selection[1]?.bindingId).toBe(binding.bindingId);
        if (manager) {
          const pending = readSessionBindingSelectionCurrent([conversation]);
          manager.stop();
          await expect(pending).rejects.toThrow("no longer active");
        }
        expect(observer.counts).toEqual(emptyCounts());
      } finally {
        observer.restore();
      }
      expect(
        inspectCurrentConversationBindingRecord(conversation)?.metadata?.lastActivityAt,
      ).toEqual(expect.any(Number));
    },
  );
});

it.each(
  (["generic", "account"] as const).flatMap((kind) =>
    (["owner-retired", "database-closed"] as const).map((change) => ({ kind, change })),
  ),
)("preserves bounded ingress classification for $kind native $change", async ({ kind, change }) => {
  const previousRegistry = captureActivePluginRegistrySnapshot();
  const channel = kind === "generic" ? "native-binding-regression" : "imessage";
  const conversation = { channel, accountId: "default", conversationId: "native-admission" };
  const supportedRegistry = () =>
    createTestRegistry([
      {
        pluginId: channel,
        source: "test",
        plugin: {
          id: channel,
          meta: { aliases: [] },
          conversationBindings: { supportsCurrentConversationBinding: true },
        },
      },
    ]);
  const manager =
    kind === "account"
      ? createAccountScopedConversationBindingManager({
          channel,
          accountId: conversation.accountId,
          cfg: { session: { threadBindings: { idleHours: 1, maxAgeHours: 0 } } },
          stateKey,
          toStoredTargetKind: (targetKind) => targetKind,
          toSessionBindingTargetKind: (targetKind) => targetKind,
        })
      : undefined;
  try {
    if (kind === "generic") {
      setActivePluginRegistry(supportedRegistry());
    }
    const binding = await getSessionBindingService().bind({
      conversation,
      targetSessionKey: "agent:target:acp:native-revocation",
      targetKind: "session",
    });
    const resolved = await resolveRuntimeConversationBindingRouteAsync({
      conversation,
      route: {
        agentId: "main",
        channel,
        accountId: conversation.accountId,
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "main",
        matchedBy: "default",
      },
    });
    const ctx = buildChannelInboundEventContext({
      channel,
      accountId: conversation.accountId,
      messageId: `native-${kind}-${change}`,
      from: "synthetic-user",
      sender: { id: "synthetic-user" },
      conversation: { kind: "direct", id: conversation.conversationId },
      route: { ...resolved.route, routeSessionKey: resolved.route.sessionKey },
      reply: { to: conversation.conversationId },
      message: { rawBody: "hello" },
    });
    await expect(resolveBoundAcpDispatchSessionKey({ ctx, cfg: {} })).resolves.toBe(
      binding.targetSessionKey,
    );

    // Capture the real native owner before its first awaited admission check resumes.
    const pending = resolveBoundAcpDispatchSessionKey({ ctx, cfg: {} }).catch(
      (error: unknown) => error,
    );
    if (change === "database-closed") {
      await closeOpenClawStateDatabaseAsync();
    } else if (manager) {
      manager.stop();
    } else {
      setActivePluginRegistry(supportedRegistry());
    }
    const failure = await pending;
    expect(failure).toBeInstanceOf(Error);
    const now = Date.now();
    const disposition = (attempts: number) =>
      resolveIngressFailureDisposition({
        err: failure,
        event: { receivedAt: now - 1_000, attempts },
        formatError: String,
        now,
      });
    expect(disposition(6)).toMatchObject({ kind: "release", attempt: 7 });
    if (change === "owner-retired") {
      expect(disposition(7)).toMatchObject({
        kind: "fail",
        reason: "session-start-conflict-retry-limit",
        attempt: 8,
      });
      expect(failure).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    } else {
      expect(failure).toMatchObject({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" });
      expect(disposition(7)).toMatchObject({ kind: "release", attempt: 8 });
    }
  } finally {
    manager?.stop();
    restoreActivePluginRegistrySnapshot(previousRegistry);
  }
});

it("reads durable delegation without run records or parent SQLite calls", async () => {
  const conversation = { channel: "policy-proof", accountId: "default", conversationId: "room" };
  const workerKeys = [
    "agent:worker:acp:delegated",
    "agent:worker:dashboard:visible",
    "agent:worker:renamed-child",
  ];
  const userKey = "agent:worker:acp:interactive";
  for (const sessionKey of [...workerKeys, userKey]) {
    replaceSessionEntrySync(
      { agentId: "worker", sessionKey },
      {
        sessionId: sessionKey.split(":").at(-1)!,
        updatedAt: 1,
        ...(sessionKey === userKey
          ? { parentSessionKey: "agent:main:main" }
          : {
              spawnDepth: 1,
              spawnedBy: "agent:main:main",
              subagentRole: "leaf" as const,
            }),
      },
    );
  }
  const initialBinding: SessionBindingRecord = {
    bindingId: "stored-worker",
    conversation,
    targetSessionKey: workerKeys[0]!,
    targetKind: "session",
    metadata: { boundBy: "human-1" },
    status: "active",
    boundAt: 1,
  };
  let saved = initialBinding;
  const bind = vi.fn(async () => saved);
  registerSessionBindingAdapter({
    ...conversation,
    bind,
    listBySession: () => [saved],
    resolveByConversation: () => saved,
    inspectByConversation: () => saved,
  });
  const observer = observeParentSqlite();
  try {
    const service = getSessionBindingService();
    for (const targetSessionKey of workerKeys) {
      saved = { ...initialBinding, targetSessionKey };
      await expect(service.bind({ ...saved, placement: "current" })).rejects.toMatchObject({
        code: "BINDING_CAPABILITY_UNSUPPORTED",
      });
      expect(bind).not.toHaveBeenCalled();
      expect(await service.inspectByConversationAsync(conversation)).toMatchObject({
        status: "available",
        binding: null,
      });
      expect(await readSessionBindingSelectionCurrent([conversation])).toEqual([null]);
    }
    saved = { ...saved, targetSessionKey: userKey };
    expect(await service.bind({ ...saved, placement: "current" })).toEqual(saved);
    expect(await readSessionBindingSelectionCurrent([conversation])).toEqual([saved]);
    expect(observer.counts).toEqual(emptyCounts());
  } finally {
    observer.restore();
  }
});
