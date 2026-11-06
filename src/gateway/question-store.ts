// Owns gateway_questions: restart facts for Gateway questions in shared state.
import type { QuestionRecord } from "../../packages/gateway-protocol/src/index.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { createOpenClawStateSchemaEnsurer } from "../state/openclaw-state-feature-schema-ensure.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";

/** Pending record as requested; never answers, secret values, requester authority, or waiters. */
export type StoredQuestion = { record: QuestionRecord; sessionId?: string };
type Mutation = { id: string; recordJson?: string };
const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: "gateway_questions",
  operationLabel: "gateway-question.schema.ensure",
});

export const gatewayQuestionOperations = {
  "gatewayQuestion.write": function writeGatewayQuestion(
    input: Mutation,
    context: WorkerWriteOperationContext,
  ): void {
    ensureSchema({ ...context.stateOptions(), database: context.open() });
    context.writeAdmitted(
      ({ db }) => {
        const k = getNodeSqliteKysely<Pick<DB, "gateway_questions">>(db);
        const row = { id: input.id, record_json: input.recordJson ?? "" };
        executeSqliteQuerySync(
          db,
          input.recordJson
            ? k
                .insertInto("gateway_questions")
                .values(row)
                .onConflict((conflict) => conflict.column("id").doUpdateSet(row))
            : k.deleteFrom("gateway_questions").where("id", "=", input.id),
        );
      },
      { operationLabel: "gateway-question.write" },
    );
  },
};
export const gatewayQuestionReadOperations = {
  "gatewayQuestion.list": function listGatewayQuestions(_input: undefined, db: EngineConnection) {
    return {
      type: "gatewayQuestion.list" as const,
      questions: !tableExists(db, "gateway_questions")
        ? []
        : executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<DB, "gateway_questions">>(db)
              .selectFrom("gateway_questions")
              .select("record_json")
              .orderBy("id"),
            // SAFETY: The question manager is the sole writer of this private, typed JSON record.
          ).rows.map((row) => JSON.parse(row.record_json) as StoredQuestion),
    };
  },
};

export function createGatewayQuestionStore(options: { env?: NodeJS.ProcessEnv } = {}) {
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const assertOwned = () => {
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
  };
  const write = async (input: Mutation) => {
    assertOwned();
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "gatewayQuestion.write", input }),
      {
        assertCurrent: assertOwned,
        createAdmission: createSqliteWorkerWriteAdmission(assertOwned, [
          context.admission.databasePath,
        ]),
      },
    );
  };
  return {
    async list(): Promise<StoredQuestion[]> {
      assertOwned();
      const reply = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath, env: context.environment },
        { type: "gatewayQuestion.list", input: undefined },
        { context, current: true },
      );
      return reply?.type === "gatewayQuestion.list" ? reply.questions : [];
    },
    upsert: (stored: StoredQuestion) =>
      write({ id: stored.record.id, recordJson: JSON.stringify(stored) }),
    remove: (id: string) => write({ id }),
  };
}

export type GatewayQuestionStore = ReturnType<typeof createGatewayQuestionStore>;
