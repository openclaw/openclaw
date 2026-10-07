import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

afterEach(() => {
  testing.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

const executionKey = "agent:main:authority-execution";
const policyKey = "agent:main:authority-policy";

it("prepares embedded tool authority without caller-thread SQL and refuses a closing owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: policyKey },
      { sessionId: "policy", updatedAt: 1, sandboxMode: "off" },
    );
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("worker-authority"),
      facts: {
        agentId: "main",
        runId: "worker-authority",
        ingress: { kind: "system", state: "present", boundary: "worker-authority-test" },
      },
    });
    try {
      const admittedRunContext = await admission.admit("embedded", "worker-authority-test");
      const attempt = {
        sessionId: "execution",
        sessionKey: executionKey,
        runId: "worker-authority",
        agentId: "main",
        config: {},
        sessionFile: "/tmp/authority-worker.jsonl",
        workspaceDir: state.workspaceDir,
        provider: "openai",
        modelId: "gpt-test",
        sandboxSessionKey: policyKey,
        senderIsOwner: true,
        messageProvider: "webchat",
      };
      const effects = vi.fn(async () => "admitted");
      const calls = observeMainThreadSql();
      try {
        await expect(
          withPreparedEmbeddedRunToolAuthority({ admittedRunContext }, attempt, undefined, effects),
        ).resolves.toBe("admitted");
        calls.expectIdle();
        const pending = withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          attempt,
          undefined,
          effects,
        );
        admission.close();
        await expect(pending).rejects.toThrow();
        expect(effects).toHaveBeenCalledTimes(1);
        calls.expectIdle();
      } finally {
        calls.restore();
      }
    } finally {
      admission.close();
    }
  });
});

it.each(["main", "policy"])(
  "rereads %s-agent sandbox policy after a foreign commit before projecting steering",
  async (policyAgent) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const classificationKey = `agent:${policyAgent}:authority-policy`;
      await upsertSessionEntryCore(
        { agentId: policyAgent, sessionKey: classificationKey },
        { sessionId: "policy", updatedAt: 1, sandboxMode: "off" },
      );
      // Settle setup maintenance before retaining the readers used across the foreign commit.
      await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      const run = createQueueTestRun({ prompt: "authority" });
      Object.assign(run.run, {
        sessionKey: executionKey,
        runtimePolicySessionKey: classificationKey,
        agentId: "main",
        config: {
          agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {}, policy: {} } },
          tools: { sandbox: { tools: { deny: ["exec"] } } },
        },
      });
      const snapshot = prepareReplyToolAuthority(run);
      const operation = createTestReplyOperation({
        sessionKey: executionKey,
        sessionId: run.run.sessionId,
      });
      await operation.bindToolAuthoritySnapshotAsync(snapshot);
      const admitted = await operation.bindToolAuthorityRouteAsync(run.run);
      const foreign = new DatabaseSync(
        resolveOpenClawAgentSqlitePath({ agentId: policyAgent, env: state.env }),
      );
      try {
        foreign
          .prepare(
            "UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.sandboxMode') WHERE session_key = ?",
          )
          .run(classificationKey);
      } finally {
        foreign.close();
      }
      const calls = observeMainThreadSql();
      try {
        expect(await snapshot.fingerprintAsync(run.run)).not.toBe(admitted);
        await expect(
          operation.projectToolAuthorityFingerprintAsync({
            senderIsOwner: run.run.senderIsOwner === true,
            disableTools: false,
            traceAuthorized: false,
          }),
        ).resolves.toBeUndefined();
        calls.expectIdle();
      } finally {
        calls.restore();
      }
    });
  },
);
