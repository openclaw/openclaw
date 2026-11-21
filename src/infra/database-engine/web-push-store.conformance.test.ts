import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { listWebPushSubscriptionsInDatabase } from "../push-web-store.database.worker.js";
import {
  hashWebPushEndpoint,
  listWebPushSubscriptions,
  upsertWebPushSubscription,
} from "../push-web-store.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { runWithSqliteWorkerStateContext } from "../sqlite-worker-state-context.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s Web Push schema admission",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("reads committed subscriptions without taking a PostgreSQL writer lock", async () => {
      const database = admit(() => openOpenClawStateDatabase());
      const endpoint = "https://push.example.test/subscription";
      const expected = {
        subscriptionId: "synthetic-subscription",
        endpoint,
        keys: { p256dh: "synthetic-public-key", auth: "synthetic-auth" },
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      };
      await expect(
        upsertWebPushSubscription({
          endpointHash: hashWebPushEndpoint(endpoint),
          endpoint,
          keys: expected.keys,
          candidateSubscriptionId: expected.subscriptionId,
          nowMs: expected.createdAtMs,
        }),
      ).resolves.toEqual(expected);
      await expect(listWebPushSubscriptions()).resolves.toEqual([expected]);

      const { db } = database;
      if (isPostgresSqlConnection(db)) {
        const statements: string[] = [];
        const query = db.query.bind(db);
        const observer = vi.spyOn(db, "query").mockImplementation(
          new Proxy(query, {
            apply(target, receiver, args) {
              statements.push(args[0]);
              return Reflect.apply(target, receiver, args);
            },
          }),
        );
        try {
          expect(
            runWithSqliteWorkerStateContext(captureOpenClawStateWorkerContext({}), () =>
              admit(() => listWebPushSubscriptionsInDatabase(database)),
            ),
          ).toEqual([expected]);
          expect(
            statements.filter((sql) => /\b(?:BEGIN|COMMIT|pg_advisory_xact_lock)\b/iu.test(sql)),
          ).toEqual([]);
          expect(statements).toHaveLength(1);
        } finally {
          observer.mockRestore();
        }
      }
    });
  },
);
