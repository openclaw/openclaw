import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readPendingInputSourceInDatabase } from "../../config/sessions/session-pending-input-source.kernel.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} submitted input source`,
    () => {
      useMixedAgentPair(engine, engine);

      it.each(["new", "pending", "committed"] as const)(
        "reads a %s source with bounded SQL and observes session replacement",
        async (source) => {
          const database = withEngineStoreAdmission(() =>
            openOpenClawAgentDatabase({ agentId: "main" }),
          );
          const input = {
            kind: "source" as const,
            sessionKey: `agent:main:source-count-${source}`,
            sessionId: `source-session-${source}`,
            idempotencyKey: "new-input:user",
            pendingOnly: false,
          };
          withEngineStoreAdmission(() => {
            ensureSessionPendingInputsSchema(database.db);
            writeSessionEntry(database, input.sessionKey, {
              sessionId: input.sessionId,
              updatedAt: 1,
            });
          });
          const scope = {
            agentId: "main",
            sessionKey: input.sessionKey,
            sessionId: input.sessionId,
          };
          const receipt =
            source === "new"
              ? undefined
              : await stageSessionPendingInput(scope, {
                  runId: "new-input",
                  message: {
                    role: "user",
                    content: "Synthetic retained input",
                    timestamp: 1,
                    idempotencyKey: input.idempotencyKey,
                  },
                  assertCurrent() {},
                });
          if (source === "committed") {
            expect(receipt).toBeDefined();
            await receipt!.run(() => appendTranscriptMessage(scope, { message: receipt!.message }));
          }
          const read = () => {
            let statements = 0;
            const observation = channel("openclaw.database.statement");
            const observer = () => {
              statements++;
            };
            observation.subscribe(observer);
            try {
              const result = withEngineStoreAdmission(() =>
                readPendingInputSourceInDatabase(database, input),
              );
              const expected =
                source === "new" || input.pendingOnly ? 1 : source === "pending" ? 6 : 9;
              expect(statements).toBe(expected);
              return result;
            } finally {
              observation.unsubscribe(observer);
            }
          };
          try {
            const result = read();
            expect(result.current).toBe(true);
            if (source === "pending") {
              expect(result.pending?.message_json).toBe(JSON.stringify(receipt!.message));
            } else if (source === "committed") {
              expect(result.committed).toEqual(receipt!.message);
              input.pendingOnly = true;
              expect(read()).toEqual({ kind: "source", current: true });
            } else {
              expect(result).toEqual({ kind: "source", current: true });
              withEngineStoreAdmission(() =>
                writeSessionEntry(database, input.sessionKey, {
                  sessionId: "replacement-session",
                  updatedAt: 2,
                }),
              );
              expect(read()).toEqual({ kind: "source", current: false });
            }
          } finally {
            receipt?.finish("interrupted");
            await receipt?.settled?.();
          }
        },
      );
    },
  );
}
