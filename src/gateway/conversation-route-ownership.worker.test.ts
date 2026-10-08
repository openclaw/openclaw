import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.core.js";
import { beginConversationDeliveryOperation } from "../config/sessions/conversation-delivery-store.js";
import {
  readConversation,
  withConversationAuthority,
} from "../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../config/sessions/conversation-route-fingerprint.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createChannelHandler } from "../infra/outbound/deliver-channel.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import {
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  resolveConversationRouteEligibilitiesForAgent,
  withAuthorizedConversationDelivery,
  withAuthorizedQueuedConversationDelivery,
} from "./conversation-route-ownership.js";

let state: OpenClawTestState;
let storePath: string;
const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  bindings: [{ type: "route", agentId: "main", match: { channel: "reef" } }],
};

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  storePath = state.statePath("conversation-authority.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});
afterAll(async () => state.cleanup());

it("expires plugin binding inspection when synchronous route preparation returns", async () => {
  const conversation = {
    channel: "reef",
    accountId: "default",
    conversationId: "preparation-lifetime",
  };
  const targetSessionKey = "agent:main:reef:channel:prepared";
  let retainedInspector:
    | Parameters<NonNullable<ChannelMessagingAdapter["prepareConversationRouteOwners"]>>[1]
    | undefined;
  const messaging: ChannelMessagingAdapter = {
    prepareConversationRouteOwners(inputs, inspectBindings) {
      retainedInspector = inspectBindings;
      const inspections = inspectBindings(
        inputs.map((input) => ({
          channel: "reef",
          accountId: input.accountId,
          conversationId: input.conversation.peerId,
        })),
      );
      expect(inspections).toMatchObject([{ status: "available", binding: { targetSessionKey } }]);
      return inspections.map(
        (inspection) => () =>
          inspection.status === "available" &&
          inspection.binding?.targetSessionKey === targetSessionKey
            ? { kind: "agent", agentId: "main" }
            : { kind: "unavailable" },
      );
    },
  };
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "reef",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "reef" }),
          conversationBindings: { supportsCurrentConversationBinding: true },
          messaging,
        },
      },
    ]),
  );
  await getSessionBindingService().bind({
    conversation,
    targetSessionKey,
    targetKind: "session",
  });
  expect(
    resolveConversationRouteEligibilitiesForAgent({
      config,
      agentId: "main",
      conversations: [
        {
          ...conversation,
          kind: "channel",
          peerId: conversation.conversationId,
          target: `reef:${conversation.conversationId}`,
        },
      ],
    }),
  ).toEqual(["eligible"]);
  expect(() => retainedInspector?.([conversation])).toThrow(
    "Conversation route preparation is no longer active",
  );
});

it.each(["final", "queued"] as const)(
  "%s authority initiates current platform effects under its worker grant and joins accepted sends",
  async (phase) => {
    const scope = { agentId: "main", databaseAgentId: "main", storePath };
    const sessionKey = `agent:main:reef:channel:${phase}`;
    const entry: SessionEntry = {
      sessionId: `session-${phase}`,
      updatedAt: 100,
      chatType: "channel",
      delivery: {
        kind: "external",
        route: {
          channel: "reef",
          accountId: "default",
          target: { to: `reef:${phase}`, chatType: "channel" },
        },
        context: { channel: "reef", accountId: "default", to: `reef:${phase}` },
        origin: { provider: "reef", accountId: "default", nativeChannelId: "native-original" },
      },
    };
    replaceSessionEntrySync({ ...scope, sessionKey }, entry);
    const conversationRef = buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "channel",
      peerId: phase,
    });
    const conversation = await readConversation(scope, conversationRef);
    expect(conversation).toMatchObject({ sessionKey, nativeChannelId: "native-original" });
    const routeFingerprint = resolveConversationRouteFingerprint(conversation!);
    const operationId = `operation-${phase}`;
    await beginConversationDeliveryOperation(scope, {
      operationId,
      conversationRef,
      operationKind: "send",
      message: "synthetic authority test",
    });
    const attempt = <T>(initiate: () => Promise<T>) =>
      phase === "final"
        ? withAuthorizedConversationDelivery(
            {
              config,
              agentId: scope.agentId,
              scope,
              conversationRef,
              expectedRouteFingerprint: routeFingerprint,
            },
            initiate,
          )
        : withAuthorizedQueuedConversationDelivery(
            { readCurrentConfig: () => config, operationId, routeFingerprint },
            scope,
            initiate,
          );
    const observeAttempt = async () => {
      const sql = observeHostDataSql();
      try {
        return await attempt(async () => undefined);
      } finally {
        sql.restore();
        // Existing shared-state route-owner checks are a separate authority boundary.
        expect(
          sql.queries.filter((query) =>
            /\b(?:conversations|conversation_deliveries|session_conversations)\b/i.test(query),
          ),
        ).toEqual([]);
      }
    };
    await expect(observeAttempt()).resolves.toBeUndefined();
    const initialForeign = new (requireNodeSqlite().DatabaseSync)(storePath);
    try {
      initialForeign.exec("PRAGMA busy_timeout = 0");
      const changeRoute = initialForeign.prepare(
        "UPDATE conversations SET native_channel_id = ? WHERE conversation_id = ?",
      );
      const held = createDeferred();
      const releaseAdmission = createDeferred();
      const blocker = runOpenClawAgentWriteAdmission(
        { agentId: "main", path: storePath },
        async () => {
          held.resolve();
          await releaseAdmission.promise;
        },
      );
      await held.promise;
      const waiting = attempt(async () => undefined);
      const observed = waiting.catch((error: unknown) => error);
      try {
        changeRoute.run("native-foreign", conversationRef);
        releaseAdmission.resolve();
        await blocker;
        await expect(waiting).rejects.toThrow("Conversation is no longer available");
      } finally {
        releaseAdmission.resolve();
        await blocker;
        await observed;
      }
      changeRoute.run("native-original", conversationRef);
      await withConversationAuthority(
        scope,
        phase === "final" ? { conversationRef } : { operationId },
        (facts) => () => {
          expect(facts.conversation?.nativeChannelId).toBe("native-original");
          // Another connection cannot supersede the selected route before attempt admission.
          expect(() => changeRoute.run("native-racing", conversationRef)).toThrow(/locked|busy/i);
        },
      );
      expect((await readConversation(scope, conversationRef))?.nativeChannelId).toBe(
        "native-original",
      );
    } finally {
      initialForeign.close();
    }

    const effect = createDeferred<{ channel: string; messageId: string }>();
    const sendText = vi.fn(() => effect.promise);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "reef",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "reef",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );
    const prepareEntered = createDeferred();
    const releasePreparation = createDeferred();
    const handler = await createChannelHandler({
      cfg: config,
      channel: "reef",
      to: `reef:${phase}`,
      withDirectAdapterHandoff: attempt,
      onDirectAdapterHandoff: async () => {
        prepareEntered.resolve();
        await releasePreparation.promise;
      },
    });
    const foreign = new (requireNodeSqlite().DatabaseSync)(storePath);
    const changeRoute = foreign.prepare(
      "UPDATE conversations SET native_channel_id = ? WHERE conversation_id = ?",
    );
    const revoked = handler.sendText("revoked during preparation");
    const revokedOutcome = revoked.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        prepareEntered.promise,
        revoked,
        "Platform preparation was not reached",
      );
      changeRoute.run("native-revoked", conversationRef);
      releasePreparation.resolve();
      await expect(revoked).rejects.toThrow("Conversation is no longer available");
      expect(sendText).not.toHaveBeenCalled();
      changeRoute.run("native-original", conversationRef);

      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      let refusedGrants = 0;
      const refusal = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) => {
          const admission = createAdmission((request, grant) => {
            if (
              request.stage === "commit" &&
              isRecord(request.facts) &&
              isRecord(request.facts.publication) &&
              request.facts.publication.kind === "conversation-authority"
            ) {
              refusedGrants++;
              admission.finish();
            }
            admit(request, grant);
          }, attachment);
          return admission;
        });
      // An illicit dispatch must settle so the regression fails without blocking cleanup.
      sendText.mockResolvedValueOnce({ channel: "reef", messageId: `refused-${phase}` });
      try {
        await expect(handler.sendText("refused before dispatch")).rejects.toThrow();
        expect(refusedGrants).toBe(1);
        expect(sendText).not.toHaveBeenCalled();
      } finally {
        refusal.mockRestore();
        sendText.mockReset();
        sendText.mockImplementation(() => effect.promise);
      }

      const entered = createDeferred();
      const release = createDeferred();
      const run = workerStore.runSqliteWorkerStoreOperation;
      vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          store: SqliteWorkerStore<Operations>,
          operation: (owner: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          context?: Parameters<typeof run>[2],
          assertCurrent?: Parameters<typeof run>[3],
          admission?: Parameters<typeof run>[4],
        ) =>
          run(
            store,
            (owner) =>
              operation({
                execute: async (command, options) => {
                  const result = await owner.execute(command, options);
                  if (command.type === "conversation.authority") {
                    entered.resolve();
                    await release.promise;
                  }
                  return result;
                },
              }),
            context,
            assertCurrent,
            admission,
          ),
      );
      const pending = handler.sendText("admitted before revocation");
      let settled = false;
      const outcome = pending
        .finally(() => {
          settled = true;
        })
        .catch((error: unknown) => error);
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "Authority reply was not held");
        // The physical method starts under the grant, before its worker reply can be delayed.
        expect(sendText).toHaveBeenCalledOnce();
        changeRoute.run("native-revoked", conversationRef);
        release.resolve();
        // The worker and FIFO release before the in-flight transport settles.
        await runOpenClawAgentWriteAdmission({ agentId: "main", path: storePath }, async () => {});
        expect(settled).toBe(false);
        effect.resolve({ channel: "reef", messageId: `sent-${phase}` });
        await expect(pending).resolves.toMatchObject({ messageId: `sent-${phase}` });
        expect(sendText).toHaveBeenCalledOnce();
        await expect(handler.sendText("after revocation")).rejects.toThrow(
          "Conversation is no longer available",
        );
        expect(sendText).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        effect.resolve({ channel: "reef", messageId: `sent-${phase}` });
        await outcome;
      }
    } finally {
      releasePreparation.resolve();
      await revokedOutcome;
      foreign.close();
    }
  },
);
