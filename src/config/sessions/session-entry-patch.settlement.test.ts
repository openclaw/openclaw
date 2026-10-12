import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import type { SessionTranscriptEventCommitted } from "./session-transcript-mutation.types.js";

it("acknowledges each independent commit in one retained worker operation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const target = {
      agentId: "main",
      sessionId: "multi-commit",
      sessionKey: "agent:main:multi-commit",
      storePath: database.path,
      env,
    };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    expect(
      appendTranscriptMessageSync(target, {
        eventId: "initial",
        message: { role: "user", content: "initial" },
      }),
    ).toMatchObject({ ok: true });
    const scope = resolveSqliteTranscriptScope(target);
    let acknowledgments = 0;
    const result = await runSessionEntryWorkerOperation<SessionTranscriptEventCommitted, number>({
      database: { ...toDatabaseOptions(scope), path: database.path },
      agentId: scope.agentId,
      candidateKind: "session-transcript-event",
      assertCurrent() {},
      async run(worker, commit) {
        let acknowledged = 0;
        for (const id of ["first", "second"]) {
          acknowledged = await commit(() =>
            executeSessionMessageRewriteOperation(worker, scope.agentId, {
              type: "session.transcript.event.append",
              input: {
                scope,
                eventJson: JSON.stringify({ type: "custom", id, parentId: "initial" }),
              },
            }),
          );
        }
        return acknowledged;
      },
      onCommitted: () => ++acknowledgments,
    });
    expect(result).toBe(2);
    expect(acknowledgments).toBe(2);
    expect(
      readTranscriptEventRows(database, target.sessionId).map(
        (row) => JSON.parse(row.eventJson).id,
      ),
    ).toEqual([target.sessionId, "initial", "first", "second"]);
  });
});
