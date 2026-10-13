import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  resolveFileMutationQueueKey,
  withFileMutationQueueKeyResolution,
} from "../agents/sessions/tools/file-mutation-queue.js";
import { prepareGatewayToolCallerAssertion } from "../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { registerSessionStateWatch } from "../sessions/session-state-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  getActiveMcpLoopbackRuntime,
  type McpLoopbackToolCallOutcome,
} from "./mcp-http.loopback-runtime.js";

vi.mock("../agents/tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/tools/gateway.js")>()),
  callGatewayTool: vi.fn(),
}));

const requesterKey = "agent:main:direct:completion-requester";
const requesterSessionId = "completion-requester-session";
const childKey = "agent:main:subagent:completion-child";
const incognitoChildKey = "agent:main:subagent:incognito-completion-child";
const childEntry: SessionEntry = {
  sessionId: "completion-child-session",
  updatedAt: 1,
  spawnedBy: requesterKey,
  spawnDepth: 1,
  subagentRole: "orchestrator",
  subagentControlScope: "children",
  inheritedToolPolicyVersion: 1,
};

let state: OpenClawTestState;
let config: OpenClawConfig;
const admissions: PreparedAgentRunAdmission[] = [];
const grants: string[] = [];
const captures: string[] = [];

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-mcp-completion-lineage-",
    layout: "state-only",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  config = {
    agents: {
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      entries: { main: { workspace: state.workspaceDir } },
    },
    plugins: { enabled: false },
    tools: { allow: ["write"] },
  };
  await state.writeConfig(config);
  await ensureMcpLoopbackServer();
});

afterEach(() => {
  resetGlobalHookRunner();
  vi.mocked(callGatewayTool).mockReset();
  for (const captureKey of captures.splice(0)) {
    clearMcpLoopbackToolCallCapture(captureKey);
  }
});

afterAll(async () => {
  for (const token of grants) {
    revokeMcpLoopbackClientGrant(token);
  }
  for (const admission of admissions) {
    admission.close();
  }
  await closeMcpLoopbackServer();
  await state?.cleanup();
});

async function seedLineage(child: Partial<SessionEntry> = {}, sourceKey = childKey) {
  await replaceSessionEntry(
    { agentId: "main", sessionKey: requesterKey },
    { sessionId: requesterSessionId, updatedAt: 1 },
  );
  await replaceSessionEntry(
    { agentId: "main", sessionKey: sourceKey },
    { ...childEntry, ...child },
  );
  clearSessionStoreCacheForTest();
}

async function removeChild() {
  runOpenClawAgentWriteTransaction((database) => deleteSessionEntryRows(database, childKey), {
    agentId: "main",
  });
  clearSessionStoreCacheForTest();
}

async function reparentChild() {
  await replaceSessionEntry(
    { agentId: "main", sessionKey: childKey },
    { ...childEntry, spawnedBy: "agent:main:direct:another-requester" },
  );
  clearSessionStoreCacheForTest();
}

async function reownChild() {
  await replaceSessionEntry(
    { agentId: "main", sessionKey: childKey },
    { ...childEntry, completionOwnerSessionKey: "agent:main:direct:another-requester" },
  );
  clearSessionStoreCacheForTest();
}

/** Mints the grant a verified Claude CLI completion turn holds and binds its capture. */
async function mintCompletionGrant(
  runId: string,
  sourceKey = childKey,
  sourceSessionId = childEntry.sessionId,
) {
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("Expected the isolated MCP runtime");
  }
  const admission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-completion-lineage-test", state: "present" },
    },
  });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("gateway");
  const grant = mintMcpLoopbackClientGrant({
    runtimeOwnerToken: runtime.ownerToken,
    admittedRunContext,
    context: {
      sessionKey: requesterKey,
      sessionId: requesterSessionId,
      agentId: "main",
      runId,
      workspaceDir: state.workspaceDir,
      cwd: state.workspaceDir,
      senderIsOwner: false,
      modelProvider: "claude-cli",
      modelId: "opus",
      toolsAllow: ["write"],
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: sourceKey,
        sourceChannel: "internal",
        sourceTool: "subagent_announce",
      },
      trustedInternalHandoff: {
        kind: "subagent-completion",
        sourceSessionKey: sourceKey,
        sourceSessionId,
        targetSessionKey: requesterKey,
        targetSessionId: requesterSessionId,
        provider: "claude-cli",
        model: "opus",
      },
    },
  });
  grants.push(grant.token);
  const captureKey = "capture-" + runId;
  captures.push(captureKey);
  const outcomes: McpLoopbackToolCallOutcome[] = [];
  // The dispatch boundary reports "prepared" synchronously before it authorizes the call.
  const prepared = createDeferredCore();
  beginMcpLoopbackToolCallCapture({
    captureKey,
    onToolCallUpdate: () => prepared.resolve(),
    onToolCallResult: (call) => outcomes.push(call),
  });
  expect(
    activateMcpLoopbackClientGrantCapture({
      token: grant.token,
      runtimeOwnerToken: runtime.ownerToken,
      captureKey,
    }),
  ).not.toBe(false);
  const target = path.join(state.workspaceDir, runId + ".txt");
  const request = (method: "tools/list" | "tools/call") =>
    fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "content-type": "application/json",
        "x-openclaw-cli-capture-key": captureKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(method === "tools/call"
          ? { params: { name: "write", arguments: { path: target, content: runId } } }
          : {}),
      }),
    });
  const written = () =>
    fs.readFile(target, "utf8").then(
      (content) => content,
      () => undefined,
    );
  return { request, written, target, outcomes, prepared: prepared.promise };
}

function registerBeforeToolCallHook(handler: () => Promise<object | void>) {
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
}

describe("MCP loopback completion lineage at the final tool-effect fence", () => {
  it.each([
    { kind: "durable", sourceKey: childKey, storedKey: childKey, sessionId: childEntry.sessionId },
    {
      kind: "incognito",
      sourceKey: incognitoChildKey,
      storedKey: incognitoChildKey,
      sessionId: childEntry.sessionId,
    },
    {
      kind: "by-id",
      sourceKey: "agent:main:subagent:lineage-id-alias",
      storedKey: childKey,
      sessionId: "agent:main:subagent:lineage-id-alias",
    },
  ])(
    "registers watches without host SQL for $kind lineage",
    async ({ kind, sourceKey, storedKey, sessionId }) => {
      await seedLineage({ sessionId }, storedKey);
      const runId = `lineage-${kind}-allowed`;
      const grant = await mintCompletionGrant(runId, sourceKey, sessionId);
      const listed = await grant.request("tools/list");
      expect(await listed.json()).toMatchObject({ result: { tools: [{ name: "write" }] } });
      let authoritySql: number | undefined;
      const watches: boolean[] = [];
      const hook = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        const sql = observeMainThreadSql();
        try {
          sql.calibrate();
          for (let index = 0; index < 2; index++) {
            watches.push(
              await registerSessionStateWatch(
                { watcherSessionKey: requesterKey, targetSessionKey: storedKey },
                { prepareCurrent: prepareGatewayToolCallerAssertion },
              ),
            );
          }
          authoritySql = sql.count();
        } finally {
          sql.restore();
        }
      });
      registerBeforeToolCallHook(hook);

      const response = await grant.request("tools/call");

      expect(await response.json()).toMatchObject({ result: { isError: false } });
      expect(hook).toHaveBeenCalledTimes(1);
      expect(watches).toEqual([true, true]);
      expect(authoritySql).toBe(0);
      expect(await grant.written()).toBe(runId);
      expect(grant.outcomes).toMatchObject([{ toolName: "write", outcome: "completed" }]);
    },
  );

  it("rolls back a watch after an incognito completion-owner change at commit", async () => {
    await seedLineage({}, incognitoChildKey);
    const grant = await mintCompletionGrant("lineage-incognito-reowned", incognitoChildKey);
    const targetSessionKey = "agent:main:dashboard:incognito-lineage-watch";
    let watched: boolean | undefined;
    let witnessed = false;
    registerBeforeToolCallHook(async () => {
      const admission = probe.admission(workerAdmission, (request, allow, admit) => {
        if (request.stage === "commit" && !witnessed) {
          witnessed = true;
          runOpenClawAgentWriteTransaction(
            (database) =>
              writeSessionEntry(database, incognitoChildKey, {
                ...childEntry,
                completionOwnerSessionKey: "agent:main:direct:another-requester",
              }),
            {
              agentId: "main",
              path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
            },
          );
        }
        admit(request, allow);
      });
      try {
        watched = await registerSessionStateWatch(
          { watcherSessionKey: requesterKey, targetSessionKey },
          { prepareCurrent: prepareGatewayToolCallerAssertion },
        );
      } finally {
        admission.mockRestore();
      }
    });
    const response = await grant.request("tools/call");
    expect(await response.json()).toMatchObject({ result: { isError: true } });
    expect(witnessed).toBe(true);
    expect(watched).toBe(false);
    expect(
      openOpenClawStateDatabase()
        .db.prepare(
          "SELECT 1 FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
        )
        .get(requesterKey, targetSessionKey),
    ).toBeUndefined();
    expect(await grant.written()).toBeUndefined();
  });

  it.each(["transaction", "commit", "prepare"] as const)(
    "rejects a watch when owner-committed lineage changes during its %s grant",
    async (stage) => {
      await seedLineage();
      const targetSessionKey = `agent:main:dashboard:lineage-watch-${stage}`;
      const watch = { watcherSessionKey: requesterKey, targetSessionKey };
      if (stage === "prepare") {
        expect(await registerSessionStateWatch(watch)).toBe(true);
      }
      // Admit the competing agent writer before the watch owns the shared-state transaction.
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const grant = await mintCompletionGrant(`lineage-watch-${stage}`);
      // A competing writer must not inherit the guarded reader's artifact-preserving context.
      const inWriterContext = AsyncLocalStorage.snapshot();
      let witnessed = false;
      let watched: boolean | undefined;
      let writeFailure: unknown;
      let committed = false;
      registerBeforeToolCallHook(async () => {
        const admission = probe.admission(workerAdmission, (request, allow, admit) => {
          if (
            request.stage === stage &&
            !witnessed &&
            request.facts !== null &&
            typeof request.facts === "object" &&
            "kind" in request.facts &&
            request.facts.kind === "session-entry-current"
          ) {
            witnessed = true;
            const replacementOwner = "agent:main:direct:another-requester";
            try {
              inWriterContext(() =>
                runSqliteImmediateTransactionSync(database.db, () =>
                  writeSessionEntry(database, childKey, {
                    ...childEntry,
                    spawnedBy: replacementOwner,
                  }),
                ),
              );
              committed = true;
            } catch (error) {
              writeFailure = error;
              throw error;
            }
          }
          admit(request, allow);
        });
        try {
          watched = await registerSessionStateWatch(watch, {
            prepareCurrent: prepareGatewayToolCallerAssertion,
          });
        } finally {
          admission.mockRestore();
        }
      });
      const response = await grant.request("tools/call");
      expect(witnessed).toBe(true);
      expect(committed, String(writeFailure)).toBe(true);
      expect(await response.json()).toMatchObject({ result: { isError: true } });
      expect(watched).toBe(false);
      const cursor = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT target_session_key FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
        )
        .get(requesterKey, targetSessionKey);
      expect(Boolean(cursor)).toBe(stage === "prepare");
      expect(await grant.written()).toBeUndefined();
    },
  );

  it("lets the completion owner write when another session controls the child", async () => {
    // The persisted completion owner, when set, is the lineage; the controller is not.
    await seedLineage({
      spawnedBy: "agent:main:direct:controller",
      completionOwnerSessionKey: requesterKey,
    });
    const grant = await mintCompletionGrant("lineage-completion-owner");

    const response = await grant.request("tools/call");

    expect(await response.json()).toMatchObject({ result: { isError: false } });
    expect(await grant.written()).toBe("lineage-completion-owner");
  });

  it.each([
    { name: "removed", runId: "lineage-removed-in-hook", revoke: removeChild },
    { name: "re-parented", runId: "lineage-reparented-in-hook", revoke: reparentChild },
    {
      name: "handed to another completion owner",
      runId: "lineage-reowned-in-hook",
      seed: { completionOwnerSessionKey: requesterKey },
      revoke: reownChild,
    },
  ] satisfies Array<{
    name: string;
    runId: string;
    seed?: Partial<SessionEntry>;
    revoke: () => Promise<void>;
  }>)(
    "rejects the write when the child lineage is $name during an awaited before-tool hook",
    async (testCase) => {
      const { runId, revoke } = testCase;
      await seedLineage("seed" in testCase ? testCase.seed : undefined);
      const grant = await mintCompletionGrant(runId);
      // The tool list resolves while the lineage still verifies.
      await (await grant.request("tools/list")).body?.cancel();
      registerBeforeToolCallHook(revoke);

      const response = await grant.request("tools/call");

      expect(await response.json()).toMatchObject({
        result: { isError: true, content: [{ text: "Tool call authorization expired" }] },
      });
      expect(await grant.written()).toBeUndefined();
      expect(grant.outcomes).toMatchObject([
        { toolName: "write", outcome: "blocked", deniedReason: "client-grant-revoked" },
      ]);
    },
  );

  it("rejects the write when the child lineage is removed during a hook approval wait", async () => {
    await seedLineage();
    const grant = await mintCompletionGrant("lineage-removed-in-approval");
    await (await grant.request("tools/list")).body?.cancel();
    registerBeforeToolCallHook(async () => ({
      requireApproval: { title: "Review write", description: "Approve the completion write" },
    }));
    const waited = vi.fn();
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      if (method === "plugin.approval.request") {
        return { id: "approval-1", status: "accepted" };
      }
      // The operator approves only after the child has been removed.
      waited(method);
      await removeChild();
      return { id: "approval-1", decision: "allow-once" };
    });

    const response = await grant.request("tools/call");

    expect(await response.json()).toMatchObject({
      result: { isError: true, content: [{ text: "Tool call authorization expired" }] },
    });
    expect(waited).toHaveBeenCalledWith("plugin.approval.waitDecision");
    expect(await grant.written()).toBeUndefined();
    expect(grant.outcomes).toMatchObject([
      { toolName: "write", outcome: "blocked", deniedReason: "client-grant-revoked" },
    ]);
  });

  it("rejects the write at its source guard when the lineage is removed after dispatch", async () => {
    await seedLineage();
    const grant = await mintCompletionGrant("lineage-removed-in-tool");
    await (await grant.request("tools/list")).body?.cancel();
    // Another mutation of the same file holds its queue, so the authorized write waits
    // inside the tool, after dispatch authorization and before its own I/O.
    const releaseQueue = createDeferredCore();
    const holder = withFileMutationQueueKeyResolution(
      resolveFileMutationQueueKey(grant.target),
      () => releaseQueue.promise,
    );

    const pending = grant.request("tools/call");
    await grant.prepared;
    await removeChild();
    releaseQueue.resolve();
    await holder;
    const response = await pending;

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        content: [
          { text: expect.stringContaining("tool invocation authority is no longer active") },
        ],
      },
    });
    expect(await grant.written()).toBeUndefined();
  });

  it("rejects a grant whose child lineage belongs to another requester", async () => {
    await seedLineage({ spawnedBy: "agent:main:direct:another-requester" });
    const grant = await mintCompletionGrant("lineage-mismatched");

    for (const method of ["tools/list", "tools/call"] as const) {
      const response = await grant.request(method);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { message: "Internal error" } });
    }
    expect(await grant.written()).toBeUndefined();
    expect(grant.outcomes).toEqual([]);
  });
});
