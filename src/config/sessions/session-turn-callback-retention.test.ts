import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { forceFullGc } from "../../test-utils/retention.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";

it.each(["commit", "rollback"] as const)(
  "releases original-input callbacks after %s while the prepared native generation stays usable",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:callback-lifetime",
        sessionId: "callback-lifetime",
      };
      replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const failure = new Error("Synthetic original-input authority refused");
      let assertions = 0;
      async function persistCaptured() {
        const payload = { marker: "synthetic original input" };
        const reference = new WeakRef(payload);
        const write = persistSessionTranscriptTurn(scope, {
          expectedSessionId: scope.sessionId,
          messages: [
            {
              message: {
                role: "user",
                content: "synthetic original input",
                timestamp: 1,
                idempotencyKey: "original-input",
              },
              workerPreparation: {
                beforeFreshMessageCommit() {
                  assertions++;
                  expect(payload.marker).toBe("synthetic original input");
                  if (outcome === "rollback") {
                    throw failure;
                  }
                },
              },
            },
          ],
          updateMode: "none",
        });
        if (outcome === "rollback") {
          await expect(write).rejects.toBe(failure);
        } else {
          await write;
        }
        return reference;
      }
      const reference = await persistCaptured();
      expect(assertions).toBeGreaterThan(0);
      const execution = captureOpenClawAgentDatabaseExecution(
        toDatabaseOptions(resolveSqliteScope(scope)),
      );
      try {
        expect(execution.capturePreparedGenerationClaim()).toBeDefined();
        const control = new WeakRef({});
        for (let pass = 0; pass < 4; pass++) {
          await nextTurn();
          forceFullGc();
        }
        expect(control.deref()).toBeUndefined();
        expect(reference.deref()).toBeUndefined();
        expect(execution.capturePreparedGenerationClaim()).toBeDefined();
        const before = await loadTranscriptEvents(scope);
        expect(before.filter((event) => isRecord(event) && event.type === "message")).toHaveLength(
          outcome === "commit" ? 1 : 0,
        );
        await persistSessionTranscriptTurn(scope, {
          expectedSessionId: scope.sessionId,
          messages: [
            {
              message: { role: "user", content: "fresh admitted input", timestamp: 2 },
            },
          ],
          updateMode: "none",
        });
        expect(
          (await loadTranscriptEvents(scope)).filter(
            (event) => isRecord(event) && event.type === "message",
          ),
        ).toHaveLength(outcome === "commit" ? 2 : 1);
      } finally {
        await execution.release();
      }
    });
  },
);
