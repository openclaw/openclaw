import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readResolvedSessionEntryInWorker,
  resolveSessionEntryCandidateTargetForRuntime,
} from "./session-accessor.entry.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";

it("keeps an unbound incognito read in its process-local store", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", env, sessionKey: "agent:main:dashboard:incognito-reader" };
    await replaceSessionEntry(
      { ...scope, storePath: resolveIncognitoOpenClawAgentSqlitePath(scope) },
      { sessionId: "private", updatedAt: 1, incognito: true },
    );
    expect(await readResolvedSessionEntryInWorker({ ...scope, cfg: {} })).toMatchObject({
      sessionId: "private",
      incognito: true,
    });
  });
});

it("keeps candidate order and observes a committed replacement through the worker", async () => {
  await withOpenClawTestState({ label: "candidate-runtime" }, async (state) => {
    const scope = { agentId: "main", env: state.env };
    const firstKey = "agent:main:first";
    const secondKey = "agent:main:second";
    const candidate = {
      ...scope,
      cfg: {},
      candidateKeys: ["agent:main:missing", firstKey, secondKey],
    };
    await replaceSessionEntry(
      { ...scope, sessionKey: firstKey },
      { sessionId: "first", updatedAt: 1, label: "before" },
    );
    await replaceSessionEntry(
      { ...scope, sessionKey: secondKey },
      { sessionId: "second", updatedAt: 2 },
    );

    const sql = observeHostDataSql();
    try {
      expect(await resolveSessionEntryCandidateTargetForRuntime(candidate)).toMatchObject({
        candidateKey: firstKey,
        sessionKey: firstKey,
        persisted: true,
        entry: { sessionId: "first", label: "before" },
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }

    await replaceSessionEntry(
      { ...scope, sessionKey: firstKey },
      { sessionId: "first", updatedAt: 1, label: "after" },
    );
    expect(await resolveSessionEntryCandidateTargetForRuntime(candidate)).toMatchObject({
      candidateKey: firstKey,
      entry: { sessionId: "first", label: "after" },
    });
  });
});
