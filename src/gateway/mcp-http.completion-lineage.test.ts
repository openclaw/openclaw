import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  resolveFileMutationQueueKey,
  withFileMutationQueueKeyResolution,
} from "../agents/sessions/tools/file-mutation-queue.js";
import { prepareGatewayToolCallerAssertion } from "../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
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
import { isIncognitoSessionKey } from "../routing/session-key.js";
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
import { closeMcpLoopbackServer } from "./mcp-http.js";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  type McpLoopbackToolCallOutcome,
} from "./mcp-http.loopback-runtime.js";
import {
  jsonHeaders,
  mcpToolCallBody,
  sendRaw,
  startLoopbackServerForTest,
} from "./mcp-http.test-support.js";

vi.mock("../agents/tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/tools/gateway.js")>()),
  callGatewayTool: vi.fn(),
}));

const requesterKey = "agent:main:direct:completion-requester";
const requesterSessionId = "completion-requester-session";
const childKey = "agent:main:subagent:completion-child";
const incognitoChildKey = "agent:main:subagent:incognito-completion-child";
const incognitoAlias = "agent:main:subagent:incognito-lineage-id-alias";
const durableAlias = "agent:main:subagent:lineage-id-alias";
const anotherRequester = "agent:main:direct:another-requester";
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
let runtime: Awaited<ReturnType<typeof startLoopbackServerForTest>>["runtime"];
let incognitoIdentity: { agentId: string; path: string };
const admissions: PreparedAgentRunAdmission[] = [];
const grants: string[] = [];
const captures: string[] = [];

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-mcp-completion-lineage-",
    layout: "state-only",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  incognitoIdentity = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
  };
  config = {
    agents: {
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      entries: { main: { workspace: state.workspaceDir } },
    },
    plugins: { enabled: false },
    tools: { allow: ["write"] },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  openOpenClawStateDatabase();
  ({ runtime } = await startLoopbackServerForTest());
});

afterEach(() => {
  resetGlobalHookRunner();
  memorySessionActorOwners.reset();
  vi.mocked(callGatewayTool).mockReset();
  captures.splice(0).forEach(clearMcpLoopbackToolCallCapture);
});

afterAll(async () => {
  grants.forEach(revokeMcpLoopbackClientGrant);
  admissions.forEach((admission) => admission.close());
  await closeMcpLoopbackServer();
  await state?.cleanup();
});

async function seedLineage(child: Partial<SessionEntry> = {}, sourceKey = childKey) {
  await replaceSessionEntry(
    { agentId: "main", sessionKey: requesterKey },
    { sessionId: requesterSessionId, updatedAt: 1 },
  );
  await updateChild(
    { ...child, ...(isIncognitoSessionKey(sourceKey) ? { incognito: true } : {}) },
    sourceKey,
  );
}

async function removeChild() {
  runOpenClawAgentWriteTransaction((database) => deleteSessionEntryRows(database, childKey), {
    agentId: "main",
  });
  clearSessionStoreCacheForTest();
}

async function updateChild(overrides: Partial<SessionEntry>, sourceKey = childKey) {
  expect(
    await replaceSessionEntry(
      { agentId: "main", sessionKey: sourceKey },
      { ...childEntry, ...overrides },
    ),
  ).not.toBeNull();
  clearSessionStoreCacheForTest();
}

async function mintCompletionGrant(
  runId: string,
  sourceKey = childKey,
  sourceSessionId = childEntry.sessionId,
) {
  const admission = prepareSystemAgentRunAdmission(
    config,
    runId,
    "main",
    "mcp-completion-lineage-test",
  );
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
    sendRaw({
      port: runtime.port,
      token: grant.token,
      headers: jsonHeaders({ "x-openclaw-cli-capture-key": captureKey }),
      body:
        method === "tools/call"
          ? mcpToolCallBody("write", { path: target, content: runId })
          : JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    });
  return {
    request,
    written: () => fs.readFile(target, "utf8").catch(() => undefined),
    target,
    outcomes,
    prepared: prepared.promise,
    call: async () => (await request("tools/call")).json(),
    list: async () => {
      await (await request("tools/list")).body?.cancel();
    },
  };
}

async function prepareCompletion(
  runId: string,
  child: Partial<SessionEntry> = {},
  sourceKey = childKey,
) {
  await seedLineage(child, sourceKey);
  const grant = await mintCompletionGrant(runId, sourceKey);
  await grant.list();
  return grant;
}

async function expectExpiredWrite(grant: Awaited<ReturnType<typeof mintCompletionGrant>>) {
  expect(await grant.call()).toMatchObject({
    result: { isError: true, content: [{ text: "Tool call authorization expired" }] },
  });
  expect(await grant.written()).toBeUndefined();
  expect(grant.outcomes).toMatchObject([
    { toolName: "write", outcome: "blocked", deniedReason: "client-grant-revoked" },
  ]);
}

function readWatch(targetSessionKey: string) {
  return openOpenClawStateDatabase()
    .db.prepare(
      "SELECT target_session_key FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
    )
    .get(requesterKey, targetSessionKey);
}

function registerBeforeToolCallHook(handler: () => Promise<object | void>) {
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
}

const watchOptions = { prepareCurrent: prepareGatewayToolCallerAssertion };
function watchTarget(targetSessionKey: string) {
  return { watcherSessionKey: requesterKey, targetSessionKey };
}

describe("MCP loopback completion lineage at the final tool-effect fence", () => {
  it.each<[string, string, string, string?, string?]>([
    ["durable", childKey, childKey],
    ["incognito", incognitoChildKey, incognitoChildKey],
    ["incognito-by-id", incognitoAlias, incognitoChildKey, incognitoAlias],
    ["mixed", incognitoChildKey, incognitoChildKey, childEntry.sessionId, childKey],
    ["by-id", durableAlias, childKey, durableAlias],
  ])(
    "registers watches without host SQL for %s lineage",
    async (kind, sourceKey, storedKey, suppliedSessionId, parentKey) => {
      const sessionId = suppliedSessionId ?? childEntry.sessionId;
      await seedLineage({ sessionId, ...(parentKey ? { spawnedBy: parentKey } : {}) }, storedKey);
      if (parentKey) {
        await replaceSessionEntry({ agentId: "main", sessionKey: parentKey }, childEntry);
      }
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
            watches.push(await registerSessionStateWatch(watchTarget(storedKey), watchOptions));
          }
          authoritySql = sql.count();
        } finally {
          sql.restore();
        }
      });
      registerBeforeToolCallHook(hook);

      expect(await grant.call()).toMatchObject({ result: { isError: false } });
      expect(hook).toHaveBeenCalledTimes(1);
      expect(watches).toEqual([true, true]);
      expect(authoritySql).toBe(0);
      expect(await grant.written()).toBe(runId);
      expect(grant.outcomes).toMatchObject([{ toolName: "write", outcome: "completed" }]);
    },
  );

  it.each([
    ["incognito", "commit"],
    ["durable", "transaction"],
    ["durable", "commit"],
    ["durable", "prepare"],
  ] as const)(
    "rejects a watch when %s lineage changes during its %s grant",
    async (kind, stage) => {
      const sourceKey = kind === "incognito" ? incognitoChildKey : childKey;
      await seedLineage({}, sourceKey);
      const targetSessionKey = `agent:main:dashboard:lineage-watch-${kind}-${stage}`;
      if (stage === "prepare") {
        expect(await registerSessionStateWatch(watchTarget(targetSessionKey))).toBe(true);
      }
      // Admit the competing agent writer before the watch owns the shared-state transaction.
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const grant = await mintCompletionGrant(`lineage-watch-${kind}-${stage}`, sourceKey);
      // A competing writer must not inherit the guarded reader's artifact-preserving context.
      const inWriterContext = AsyncLocalStorage.snapshot();
      let witnessed = false;
      let committed = false;
      let watched: boolean | undefined;
      registerBeforeToolCallHook(async () => {
        const admission = probe.admission(workerAdmission, (request, allow, admit) => {
          const facts = request.facts;
          if (
            request.stage === stage &&
            !witnessed &&
            (kind === "incognito" || (isRecord(facts) && facts.kind === "session-entry-current"))
          ) {
            witnessed = true;
            if (kind === "incognito") {
              memorySessionActorOwners.closeSession(incognitoIdentity, incognitoChildKey);
            } else {
              inWriterContext(() =>
                runSqliteImmediateTransactionSync(database.db, () =>
                  writeSessionEntry(database, childKey, {
                    ...childEntry,
                    spawnedBy: anotherRequester,
                  }),
                ),
              );
            }
            committed = true;
          }
          admit(request, allow);
        });
        try {
          watched = await registerSessionStateWatch(watchTarget(targetSessionKey), watchOptions);
        } finally {
          admission.mockRestore();
        }
      });
      const response = await grant.call();
      expect({ witnessed, committed, watched }).toEqual({
        witnessed: true,
        committed: true,
        watched: false,
      });
      expect(response).toMatchObject({ result: { isError: true } });
      const cursor = readWatch(targetSessionKey);
      if (kind === "incognito") {
        expect(cursor).toBeUndefined();
      } else {
        expect(Boolean(cursor)).toBe(stage === "prepare");
      }
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

    expect(await grant.call()).toMatchObject({ result: { isError: false } });
    expect(await grant.written()).toBe("lineage-completion-owner");
  });

  it.each<[string, () => Promise<void>, Partial<SessionEntry>?, string?]>([
    ["removed", removeChild],
    ["re-parented", () => updateChild({ spawnedBy: anotherRequester })],
    [
      "handed to another completion owner",
      () => updateChild({ completionOwnerSessionKey: anotherRequester }),
      { completionOwnerSessionKey: requesterKey },
    ],
    [
      "reassigned in memory",
      () => updateChild({ completionOwnerSessionKey: anotherRequester }, incognitoChildKey),
      {},
      incognitoChildKey,
    ],
  ])(
    "rejects the write when the child lineage is %s during an awaited before-tool hook",
    async (name, revoke, seed = {}, sourceKey = childKey) => {
      const grant = await prepareCompletion(`lineage-${name}-in-hook`, seed, sourceKey);
      registerBeforeToolCallHook(revoke);

      await expectExpiredWrite(grant);
    },
  );

  it("rejects the write when the child lineage is removed during a hook approval wait", async () => {
    const grant = await prepareCompletion("lineage-removed-in-approval");
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

    await expectExpiredWrite(grant);
    expect(waited).toHaveBeenCalledWith("plugin.approval.waitDecision");
  });

  it("rejects the write at its source guard when the lineage is removed after dispatch", async () => {
    const grant = await prepareCompletion("lineage-removed-in-tool");
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
    await seedLineage({ spawnedBy: anotherRequester });
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
