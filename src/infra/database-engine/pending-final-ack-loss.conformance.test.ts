import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it, vi } from "vitest";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import {
  useOutboundRuntime,
  installQueueTestPlugin,
} from "../outbound/deliver.custody.test-support.js";
import {
  markFinal,
  seedDeliverySession,
} from "../outbound/delivery-completion.shard-test-support.js";
import { awaitCustodyReply } from "../outbound/delivery-queue-custody.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../outbound/delivery-queue-namespaces.js";
import { recoverPendingDeliveries } from "../outbound/delivery-queue-recovery.js";
import { holdAcknowledgementReply } from "../outbound/delivery-queue-worker-reply.test-support.js";
import {
  createRecoveryLog,
  loadPendingDeliveries,
} from "../outbound/delivery-queue.test-helpers.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const engine = mixedAgentConnection ? "postgres" : "sqlite";

describe(`${engine} pending-final acknowledgement loss`, () => {
  const pair = useMixedAgentPair(engine, engine);
  const outbound = useOutboundRuntime();

  it("retains the delivered receipt across committed ACK reply loss without resending", async () => {
    installQueueTestPlugin();
    const { scope, entry, context } = await seedDeliverySession(pair.root);
    const payloads = [{ text: "final output" }];
    await markFinal(scope, entry, payloads, context);
    const completion = resolvePendingFinalDeliveryCompletion(payloads);
    if (!completion) {
      throw new Error("Missing pending-final completion");
    }
    const receipt = () => loadSessionEntry(scope);
    const expected = {
      sessionId: completion.sessionId,
      pendingFinalDelivery: {
        intentId: completion.intentId,
        deliveries: [
          {
            id: completion.deliveryId,
            state: "delivered",
            receipt: { platformMessageId: "accepted-final", resultCount: 1 },
          },
        ],
      },
    };
    const send = vi.fn(async () => ({ messageId: "accepted-final" }));
    const reply = holdAcknowledgementReply(completion.deliveryId);
    const outcome = outbound
      .deliver({
        cfg: {},
        ...context,
        payloads,
        deliveryCompletion: completion,
        deliveryIntentId: completion.deliveryId,
        queuePolicy: "required",
        deps: { matrix: send },
      })
      .then(
        (results) => results,
        (error: unknown) => error,
      );
    try {
      await awaitCustodyReply(reply.held, outcome);
      // The real queue commit must follow the session owner's durable receipt.
      expect(receipt()).toMatchObject(expected);
      expect(send).toHaveBeenCalledTimes(1);
      await reply.lose();
      const failure = await outcome;
      expect(failure).toBeInstanceOf(Error);
      expect(collectNestedErrorCandidates(failure).map(extractErrorCode)).toContain(
        "outcome-unknown",
      );
      expect(reply.attempts()).toBe(1);
    } finally {
      reply.restore();
      reply.release();
      await outcome;
    }

    await closeOpenClawAgentDatabasesAsync(pair.root);
    await closeOpenClawStateDatabaseAsync();
    expect(receipt()).toMatchObject(expected);
    withEngineStoreAdmission(() => {
      const agent = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
      expect(isPostgresSqlConnection(agent.db)).toBe(engine === "postgres");
      expect(isPostgresSqlConnection(openOpenClawStateDatabase().db)).toBe(engine === "postgres");
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, completion.deliveryId, pair.root),
      ).toBeUndefined();
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await recoverPendingDeliveries({
        cfg: {},
        stateDir: pair.root,
        log: createRecoveryLog(),
        deliver: (params) => outbound.deliver({ ...params, deps: { matrix: send } }),
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(await loadPendingDeliveries(pair.root)).toEqual([]);
      expect(receipt()).toMatchObject(expected);
    }
  });
});
