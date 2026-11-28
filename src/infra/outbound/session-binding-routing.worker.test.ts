import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as sqlite from "../../../test/helpers/sqlite-parent-observer.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveBoundAcpDispatchSessionKey } from "../../auto-reply/reply/dispatch-from-config.context.js";
import { createIngressRetryPolicy } from "../../channels/message/ingress-retry-policy.js";
import { buildChannelInboundEventContext } from "../../plugin-sdk/channel-inbound.js";
import {
  getSessionBindingService,
  resolveRuntimeConversationBindingRouteAsync,
} from "../../plugin-sdk/conversation-binding-runtime.js";
import {
  createAccountScopedConversationBindingManager,
  resetAccountScopedConversationBindingsForTests,
} from "../../plugin-sdk/thread-bindings-runtime.js";
import * as registry from "../../plugins/runtime.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { inspectCurrentConversationBindingRecord } from "./current-conversation-bindings.js";
import { readSessionBindingSelectionCurrent, testing } from "./session-binding-service.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const stateKey = Symbol("binding-routing-worker-proof");
let previousRegistry: ReturnType<typeof registry.captureActivePluginRegistrySnapshot>;
async function bindFixture(kind: "generic" | "account", native = false) {
  const channel =
    kind === "account" ? "imessage" : native ? "native-binding-regression" : "webchat";
  const conversation = {
    channel,
    accountId: "default",
    conversationId: native ? "native-admission" : "worker-route",
  };
  const plugin = {
    id: channel,
    conversationBindings: { supportsCurrentConversationBinding: true },
  };
  const supportedRegistry = () =>
    createTestRegistry([{ pluginId: channel, source: "test", plugin }]);
  if (native && kind === "generic") {
    registry.setActivePluginRegistry(supportedRegistry());
  }
  const manager =
    kind === "account"
      ? createAccountScopedConversationBindingManager({
          channel,
          accountId: "default",
          stateKey,
          cfg: { session: { threadBindings: { idleHours: 1, maxAgeHours: 0 } } },
          toStoredTargetKind: (targetKind) => targetKind,
          toSessionBindingTargetKind: (targetKind) => targetKind,
        })
      : undefined;
  const binding = await getSessionBindingService().bind({
    conversation,
    targetSessionKey: native ? "agent:target:acp:native-revocation" : "agent:target:main",
    targetKind: "session",
  });
  const route = resolveAgentRoute({ cfg: {}, channel, defaultAgentId: "main" });
  const retire = () =>
    manager ? manager.stop() : registry.setActivePluginRegistry(supportedRegistry());
  return { conversation, manager, binding, route, retire };
}

beforeEach(() => {
  previousRegistry = registry.captureActivePluginRegistrySnapshot();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-binding-route-worker-"));
  testing.resetSessionBindingAdaptersForTests();
});
afterEach(async () => {
  resetAccountScopedConversationBindingsForTests({ stateKey });
  registry.restoreActivePluginRegistrySnapshot(previousRegistry);
  testing.resetSessionBindingAdaptersForTests();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it.each(["generic", "account"] as const)(
  "routes and records activity for %s bindings without parent SQLite calls",
  async (kind) => {
    const fixture = await bindFixture(kind);
    const { conversation, manager, binding } = fixture;
    const observer = sqlite.observeParentSqlite();
    try {
      const result = await resolveRuntimeConversationBindingRouteAsync(fixture);
      expect(result.route.sessionKey).toBe(binding.targetSessionKey);
      const selection = await readSessionBindingSelectionCurrent([
        { ...conversation, conversationId: "missing" },
        {
          ...conversation,
          accountId: " DEFAULT ",
          conversationId: " worker-route ",
          parentConversationId: kind === "account" ? "account-ignored-parent" : undefined,
        },
      ]);
      expect(selection).toMatchObject([null, { bindingId: binding.bindingId }]);
      if (manager) {
        const pending = readSessionBindingSelectionCurrent([conversation]);
        manager.stop();
        await expect(pending).rejects.toThrow("no longer active");
      }
      expect(observer.counts).toEqual(sqlite.emptySqliteCounts());
    } finally {
      observer.restore();
    }
    expect(inspectCurrentConversationBindingRecord(conversation)?.metadata?.lastActivityAt).toEqual(
      expect.any(Number),
    );
  },
);

it.each(
  (["generic", "account"] as const).flatMap((kind) =>
    (["owner-retired", "database-closed"] as const).map((change) => ({ kind, change })),
  ),
)("retries native $kind $change under the ingress age gate", async ({ kind, change }) => {
  const fixture = await bindFixture(kind, true);
  const { binding, conversation } = fixture;
  const resolved = await resolveRuntimeConversationBindingRouteAsync(fixture);
  const ctx = buildChannelInboundEventContext({
    channel: conversation.channel,
    from: "synthetic-user",
    sender: { id: "synthetic-user" },
    conversation: { kind: "direct", id: conversation.conversationId },
    route: { ...resolved.route, routeSessionKey: resolved.route.sessionKey },
    reply: { to: conversation.conversationId },
    message: { rawBody: "hello" },
  });
  const dispatch = () => resolveBoundAcpDispatchSessionKey({ ctx, cfg: {} });
  await expect(dispatch()).resolves.toBe(binding.targetSessionKey);

  // Capture the real native owner before its first awaited admission check resumes.
  const pending = dispatch().catch((error: unknown) => error);
  if (change === "database-closed") {
    await closeOpenClawStateDatabaseAsync();
  } else {
    fixture.retire();
  }
  const failure = await pending;
  expect(failure).toBeInstanceOf(Error);
  const disposition = (attempts: number) =>
    createIngressRetryPolicy({}).failure({
      err: failure,
      event: { id: "binding-route", receivedAt: 0, attempts },
      formatError: String,
      now: 1_000,
    });
  expect(disposition(6)).toMatchObject({ kind: "release", attempt: 7 });
  expect(disposition(7)).toMatchObject({ kind: "release", attempt: 8 });
  if (change === "owner-retired") {
    expect(failure).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  } else {
    expect(failure).toMatchObject({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" });
  }
});
