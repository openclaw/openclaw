import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { prepareSqliteScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { executeSessionQuestionOperation } from "../../config/sessions/session-questions.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDurableQuestionSessionAccess } from "../question-session-durable-access.js";
import * as questionPreparation from "../question-session-preparation.js";
import {
  adminRequestClient,
  callQuestionRpc,
  installQuestionTestHooks,
  manager,
  requestParams,
} from "./question.test-support.js";

installQuestionTestHooks();

it.each(["before canonical read", "during preparation"] as const)(
  "omits retired physical custody %s without hiding a healthy sibling",
  async (stage) => {
    vi.useRealTimers();
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const staleScope = { agentId: "main", sessionKey: "agent:main:main" };
      const healthyScope = { agentId: "healthy", sessionKey: "agent:healthy:main" };
      const staleEntry = {
        sessionId: "stale-session",
        lifecycleRevision: "stale-generation",
        updatedAt: 1,
      };
      await upsertSessionEntryCore(staleScope, staleEntry);
      await upsertSessionEntryCore(healthyScope, {
        sessionId: "healthy-session",
        lifecycleRevision: "healthy-generation",
        updatedAt: 1,
      });
      const target = await prepareSqliteScope(staleScope);
      const databasePath =
        target.path ?? resolveOpenClawAgentSqlitePath({ agentId: target.agentId, env: target.env });
      const identity = readDatabasePathIdentitySync(databasePath);
      const binding = {
        ...staleScope,
        storePath: target.ownerStorePath ?? databasePath,
        databasePath,
        databaseIdentity: {
          identity: identity.key.slice("file:".length),
          birthtime: identity.birthtime,
        },
        sessionId: staleEntry.sessionId,
        lifecycleRevision: staleEntry.lifecycleRevision,
      };
      const stale = manager.request({
        id: "retired-custody",
        questions: requestParams.questions,
        agentId: staleScope.agentId,
        sessionKey: staleScope.sessionKey,
        runId: "retired-asking-run",
        timeoutMs: 900_000,
        sessionAccess: createDurableQuestionSessionAccess(binding),
        durableCustody: {
          settle: async () => {
            throw new Error("List must not settle a retired question");
          },
          onContinuationOwed: () => {},
        },
      });
      await executeSessionQuestionOperation(
        { ...staleScope, storePath: binding.storePath, assertCurrent() {} },
        {
          kind: "register",
          question: {
            record: stale,
            sessionKey: staleScope.sessionKey,
            sessionId: staleEntry.sessionId,
            lifecycleRevision: staleEntry.lifecycleRevision,
            provenance: { issuer: "operator", sourceRunId: "retired-asking-run" },
            sessionBinding: binding,
            continuation: { status: "pending" },
          },
        },
      );
      const healthy = manager.request({
        id: "healthy-custody",
        questions: requestParams.questions,
        ...healthyScope,
        timeoutMs: 900_000,
      });
      const replaceOriginalStore = async () => {
        await closeOpenClawAgentDatabaseByPathAsync(databasePath);
        fs.renameSync(databasePath, state.statePath("retired-agent.sqlite"));
        await upsertSessionEntryCore(
          { ...staleScope, storePath: databasePath },
          {
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-generation",
            updatedAt: 2,
          },
        );
      };
      if (stage === "before canonical read") {
        await replaceOriginalStore();
      } else {
        const prepare = questionPreparation.withPreparedQuestionSessions;
        const retireThenPrepare: typeof prepare = async (...args) => {
          await replaceOriginalStore();
          return prepare(...args);
        };
        vi.spyOn(questionPreparation, "withPreparedQuestionSessions").mockImplementationOnce(
          retireThenPrepare,
        );
      }
      const result = await callQuestionRpc(
        "question.list",
        { includeContinuation: true },
        {
          client: adminRequestClient,
          cfg: { agents: { entries: { main: {}, healthy: {} } } },
        },
      );
      expect(result[0], JSON.stringify(result[2])).toBe(true);
      expect(result[1]).toEqual({ questions: [healthy], continuations: [] });
      expect(manager.observe(stale.id)).toBeNull();
      expect(manager.observe(healthy.id)?.isCurrent()).toBe(true);
    });
  },
);
