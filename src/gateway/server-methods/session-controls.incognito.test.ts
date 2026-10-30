import "./tools-effective.test-support.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  admitModelTurn,
  completionConfig,
} from "../../agents/bash-tools.lifecycle.test-support.js";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import * as sessionEventHandoff from "../../auto-reply/reply/session-event-handoff.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { NODE_CLAUDE_SKILLS_CAPABILITY } from "../../infra/node-claude-skill-protocol.js";
import { NODE_AGENT_CLI_CLAUDE_RUN_COMMAND } from "../../infra/node-commands.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { resolveNodeHostGatewayPlatformIdentity } from "../../node-host/gateway-platform-identity.js";
import { preparePluginMetadataMachineStateAsync } from "../../plugins/installed-plugin-index-record-state.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveApprovalSessionAudienceWithFallback } from "../approval-session-audience.js";
import { prepareNodeClaudeSkillRuntime } from "../node-claude-skill-runtime.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient } from "../node-registry.test-helpers.js";
import { handleNodeEvent } from "../server-node-events.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { createTerminalLaunchPolicy } from "../terminal/launch.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import { systemHandlers } from "./system.js";
import { openTerminalSession } from "./terminal.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { toolsEffectiveInventoryMocks } = await import("./tools-effective.test-support.js");
const { testing, toolsEffectiveHandlers } = await import("./tools-effective.js");

const { cfg, prepareRegistry, ingress } = vi.hoisted(() => ({
  cfg: {
    agents: { entries: { main: {}, native: {}, sibling: {} } },
    gateway: { terminal: { enabled: true } },
  },
  ingress: vi.fn(async () => {}),
  prepareRegistry: vi.fn(async () => false),
}));
// mock-isolation: Node ingress and model I/O are synthetic; wake admission and actor storage stay real.
vi.mock("../../commands/agent.js", () => ({ agentCommandFromIngress: ingress }));
// mock-isolation: Keep model I/O synthetic while the real dispatcher owns wake admission and settlement.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
vi.mock("../../config/io.js", async (original) => ({
  ...(await original<typeof import("../../config/io.js")>()),
  getRuntimeConfig: () => cfg,
}));
vi.mock("../../agents/subagents/registry/subagent-registry-state.js", async (original) => ({
  ...(await original<
    typeof import("../../agents/subagents/registry/subagent-registry-state.js")
  >()),
  prepareOptionalSubagentSessionListReadCache: prepareRegistry,
}));

await Promise.all([
  import("../../auto-reply/dispatch.js"),
  import("../../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);
const model = vi.mocked(runEmbeddedAgent);
const wakeReceipts: ReturnType<typeof sessionEventHandoff.enqueueSessionEventForHost>[] = [];

const dirs = useAutoCleanupTempDirTracker(afterAll);
let env: NodeJS.ProcessEnv;
const context = createGatewayRequestContext(makeContextParams());
context.getRuntimeConfig = () => cfg;
context.getCommittedRuntimeConfig = () => cfg;
context.publishPresence = vi.fn();

function actorEntry(sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: Date.now(), incognito: true, ...fields };
}

function pause() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  return {
    entered: entered.promise,
    release: release.resolve,
    async wait() {
      entered.resolve();
      await release.promise;
    },
  };
}

function request(method: string, params: Record<string, unknown>): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "test", method },
    params,
    client: null,
    isWebchatConnect: () => true,
    context,
    respond: vi.fn(),
  };
}

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: dirs.make("incognito-session-controls-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const configPath = path.join(env.OPENCLAW_STATE_DIR!, "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  const completion = completionConfig(path.join(env.OPENCLAW_STATE_DIR!, "workspace"));
  Object.assign(cfg, {
    ...completion,
    agents: { ...completion.agents, entries: cfg.agents.entries },
  });
  await fs.writeFile(configPath, JSON.stringify(cfg));
  openOpenClawStateDatabase();
});
beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  setRuntimeConfigSnapshot(cfg);
  // Shared cleanup retires plugin facts, so each case repeats Gateway startup preparation.
  await preparePluginMetadataMachineStateAsync({ env: process.env });
  const enqueue = sessionEventHandoff.enqueueSessionEventForHost;
  vi.spyOn(sessionEventHandoff, "enqueueSessionEventForHost").mockImplementation((...args) => {
    const receipt = enqueue(...args);
    wakeReceipts.push(receipt);
    return receipt;
  });
  model.mockReset();
});
afterEach(async () => {
  for (const receipt of wakeReceipts) {
    receipt.cancel();
  }
  await Promise.allSettled(wakeReceipts.splice(0).map((receipt) => receipt.settled));
  clearRuntimeConfigSnapshot();
  testing.resetToolsEffectiveCacheForTest();
  toolsEffectiveInventoryMocks.resolveEffectiveToolInventory.mockClear();
  ingress.mockClear();
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});
afterAll(async () => {
  memorySessionActorOwners.reset();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

async function processWake(sessionKey: string, text: string) {
  const options = request("system-event", { text, sessionKey, wake: true });
  const original = loadSessionEntry({ sessionKey });
  assert(original);
  model.mockImplementationOnce(async (params) => {
    await admitModelTurn(params);
    return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
  });
  await systemHandlers["system-event"]!(options);
  expect(wakeReceipts).toHaveLength(1);
  await expect(wakeReceipts[0]!.settled).resolves.toMatchObject({
    status: "completed",
    executionStarted: true,
  });
  expect(options.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  expect(model).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sessionKey,
      sessionId: original.sessionId,
      prompt: expect.stringContaining(text),
    }),
  );
  expect(peekSystemEvents(sessionKey)).toEqual([]);
}

it.each([false, true])(
  "guards actor tool disclosure after catalogue preparation (replaced=%s)",
  async (replaced) => {
    const sessionKey = `agent:main:dashboard:incognito-tools-${replaced}`;
    const entry = actorEntry(`tools-${replaced}`, { model: "gpt-4.1", modelProvider: "openai" });
    await replaceSessionEntry({ sessionKey }, entry);
    const preparation = pause();
    toolsEffectiveInventoryMocks.resolveEffectiveToolInventory.mockImplementationOnce(async () => {
      await preparation.wait();
      return { agentId: "main", profile: "coding", groups: [] };
    });
    const options = request("tools.effective", { agentId: "main", sessionKey });
    const host = observeHostDataSql();
    try {
      const pending = Promise.resolve(toolsEffectiveHandlers["tools.effective"]!(options));
      try {
        await awaitGateBeforeSettlement(
          preparation.entered,
          pending.then(() => {
            const response = vi.mocked(options.respond).mock.calls[0];
            if (response?.[2]) {
              throw new Error(response[2].message);
            }
          }),
          "Tool inventory handler settled before catalogue preparation",
        );
        if (replaced) {
          await replaceSessionEntry(
            { agentId: "main", sessionKey },
            { ...entry, sessionId: "successor" },
          );
        }
      } finally {
        preparation.release();
        await pending;
      }
      expect(options.respond).toHaveBeenCalledWith(
        !replaced,
        replaced ? undefined : expect.objectContaining({ groups: [] }),
        replaced ? expect.any(Object) : undefined,
      );
      expect(host.queries).toEqual([]);
    } finally {
      preparation.release();
      host.restore();
    }
  },
);

it("refuses terminal ownership after its actor session is replaced during catalogue preparation", async () => {
  const sessionKey = "agent:main:dashboard:incognito-terminal";
  const entry = actorEntry("terminal-source");
  await replaceSessionEntry({ sessionKey }, entry);
  const preparation = pause();
  const policy = createTerminalLaunchPolicy(cfg);
  const manager = new TerminalSessionManager({ emit: vi.fn() });
  const open = vi.spyOn(manager, "open").mockResolvedValue({
    ok: false,
    code: "spawn_failed",
    message: "Unexpected terminal admission",
  });
  const options = request("terminal.open", {});
  options.client = {
    ...sharingPolicyClient({ scopes: ["operator.admin"] }),
    connId: "terminal-connection",
  };
  options.context = {
    ...context,
    terminalSessions: manager,
    resolveTerminalLaunchPolicy: policy.resolve,
    isTerminalEnabled: policy.isEnabled,
    isConnectionActive: () => true,
  };
  const pending = openTerminalSession(options, {
    agentId: "main",
    sessionKey,
    cols: 80,
    rows: 24,
    resolveCatalogPlan: async () => {
      await preparation.wait();
      return { kind: "local", argv: ["synthetic-shell"], cwd: "/synthetic" };
    },
  });
  const settled = pending.catch(() => {});
  try {
    await awaitGateBeforeSettlement(
      preparation.entered,
      pending,
      "Terminal settled before catalogue preparation",
    );
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { ...entry, sessionId: "replacement" },
    );
  } finally {
    preparation.release();
    await settled;
  }
  await expect(pending).rejects.toThrow(/session|current/i);
  expect(open).not.toHaveBeenCalled();
  manager.disposeAll();
});

it("routes actor system wakes and parent approval audiences without host SQL", async () => {
  const parent = "agent:sibling:dashboard:incognito-control-parent";
  const grandparent = "agent:main:dashboard:incognito-control-grandparent";
  const child = "agent:main:dashboard:incognito-control-child";
  await replaceSessionEntry({ sessionKey: grandparent }, actorEntry("grandparent"));
  await replaceSessionEntry(
    { agentId: "sibling", sessionKey: parent },
    actorEntry("parent", { parentSessionKey: grandparent }),
  );
  await replaceSessionEntry(
    { sessionKey: child },
    actorEntry("child", { parentSessionKey: parent }),
  );
  const host = observeHostDataSql();
  try {
    await processWake(child, "Synthetic wake");
    expect(await resolveApprovalSessionAudienceWithFallback(child, "main")).toEqual([
      child,
      parent,
      grandparent,
    ]);
    expect(host.queries).toEqual([]);
  } finally {
    host.restore();
  }
});

it("rejects a replaced actor source during approval lineage preparation", async () => {
  const sessionKey = "agent:main:dashboard:incognito-approval-replaced";
  const entry = actorEntry("approval-source");
  await replaceSessionEntry({ sessionKey }, entry);
  const preparation = pause();
  prepareRegistry.mockImplementationOnce(async () => {
    await preparation.wait();
    return false;
  });
  const pending = resolveApprovalSessionAudienceWithFallback(sessionKey, "main");
  const settled = pending.catch(() => {});
  try {
    await awaitGateBeforeSettlement(
      preparation.entered,
      pending,
      "Approval lineage settled before registry preparation",
    );
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { ...entry, sessionId: "successor" },
    );
  } finally {
    preparation.release();
    await settled;
  }
  await expect(pending).rejects.toThrow(/session|current/i);
});

it("preserves an unbound native wake without allocating another owner", async () => {
  const sessionKey = "agent:native:dashboard:incognito-native-controls";
  await replaceSessionEntry(
    { agentId: "native", sessionKey },
    { sessionId: sessionKey, updatedAt: Date.now() },
  );
  const before = memorySessionActorOwners.list();
  await processWake(sessionKey, "Native wake");
  expect(memorySessionActorOwners.list()).toEqual(before);
});

it("joins accepted actor node work, preserves changed session settings, and canonicalizes subscriptions without host SQL", async () => {
  const sessionKey = "agent:main:dashboard:incognito-node-event";
  await replaceSessionEntry({ sessionKey }, actorEntry("node-event", { sendPolicy: "allow" }));
  const selection = pause();
  const ingressWork = pause();
  let connectionChecks = 0;
  ingress.mockImplementationOnce(() => ingressWork.wait());
  const subscribe = vi.fn();
  const nodeContext = {
    ...context,
    nodeSubscribe: subscribe,
    nodeUnsubscribe: vi.fn(),
    nodeSendToSession: vi.fn(),
    authorizeNodeSystemRunEvent: () => false,
  };
  const admission = tryBeginGatewayRootWorkAdmission();
  assert(admission);
  const host = observeHostDataSql();
  try {
    let settled = false;
    const pending = admission
      .run(() =>
        handleNodeEvent(
          nodeContext,
          "synthetic-node",
          {
            event: "voice.transcript",
            payloadJSON: JSON.stringify({ sessionKey, text: "Synthetic voice turn" }),
          },
          {
            isConnectionCurrent: async () => {
              connectionChecks += 1;
              if (connectionChecks === 2) {
                await selection.wait();
              }
              return true;
            },
          },
        ),
      )
      .then(() => {
        settled = true;
      });
    try {
      await awaitGateBeforeSettlement(
        selection.entered,
        pending,
        "Node event settled before session selection",
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sendPolicy: "deny", thinkingLevel: "high", systemSent: true },
      );
      selection.release();
      await awaitGateBeforeSettlement(
        ingressWork.entered,
        pending,
        "Node event settled before ingress admission",
      );
      expect(settled).toBe(false);
    } finally {
      selection.release();
      ingressWork.release();
      await pending;
    }
    expect(loadSessionEntry({ sessionKey })).toMatchObject({
      sendPolicy: "deny",
      thinkingLevel: "high",
      systemSent: true,
    });
    await handleNodeEvent(nodeContext, "synthetic-node", {
      event: "chat.subscribe",
      payloadJSON: JSON.stringify({ sessionKey }),
    });
    expect(ingress).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, sessionId: "node-event" }),
      expect.anything(),
      expect.anything(),
    );
    expect(subscribe).toHaveBeenCalledWith("synthetic-node", sessionKey, undefined);
    expect(host.queries).toEqual([]);
  } finally {
    selection.release();
    ingressWork.release();
    admission.release();
    host.restore();
  }
});

it.each(["actor", "native"] as const)(
  "keeps prepared skill pins and revokes reassigned node callbacks (%s)",
  async (sourceKind) => {
    const agentId = sourceKind === "actor" ? "main" : "native";
    const sessionKey =
      sourceKind === "actor"
        ? "agent:main:dashboard:incognito-node-skills"
        : "agent:native:node-skills";
    const entry = actorEntry("node-skills", {
      incognito: sourceKind === "actor" ? true : undefined,
      execHost: "node",
      execNode: "skill-node",
      execCwd: "/synthetic",
    });
    await replaceSessionEntry({ agentId, sessionKey }, entry);
    const registry = new NodeRegistry();
    const nodeClient = makeClient("skill-connection", "skill-node", [], {
      clientId: "openclaw-node-host",
      caps: [NODE_CLAUDE_SKILLS_CAPABILITY],
      commands: [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND],
    });
    Object.assign(nodeClient.connect.client, resolveNodeHostGatewayPlatformIdentity("linux"));
    registry.register(nodeClient, {
      pairingIdentity: "skill-node",
      pairingGeneration: "generation-1",
    });
    const runId = `node-skill-run-${sourceKind}`;
    const admission = prepareSystemAgentRunAdmission(cfg, runId, agentId, "test");
    const run = buildPreparedCliRunContext({
      sessionKey,
      sessionId: entry.sessionId,
      sessionEntry: entry,
      agentId,
      runId,
    });
    run.params.admittedRunContext = await admission.admit("plugin-harness");
    run.nodeSkillWorkshop = {
      name: "skill_workshop",
      label: "Workshop",
      description: "Synthetic workshop",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    };
    const gateway = {
      ...context,
      nodeRegistry: registry,
      workerSessionPlacementService: undefined,
    };
    const host = sourceKind === "actor" ? observeHostDataSql() : undefined;
    let runtime: Awaited<ReturnType<typeof prepareNodeClaudeSkillRuntime>>;
    try {
      await withPluginRuntimeGatewayRequestScope(
        { context: gateway, client: undefined, isWebchatConnect: () => true },
        async () => {
          runtime = await prepareNodeClaudeSkillRuntime(run, new AbortController().signal);
          assert(runtime);
          runtime.assertCurrent();
          await upsertSessionEntryCore(
            { agentId, sessionKey },
            {
              skillLibrarySelections: [
                {
                  skillId: "next-turn-skill",
                  revision: "a".repeat(64),
                  name: "next-turn-skill",
                  ownerProfileId: null,
                },
              ],
            },
          );
          runtime.assertCurrent();
          await replaceSessionEntry(
            { agentId, sessionKey },
            { ...entry, execNode: "replacement-node" },
          );
          expect(() => runtime!.assertCurrent()).toThrow(/assignment|authority/);
          await runtime.close();
        },
      );
      if (host) {
        expect(host.queries).toEqual([]);
      }
    } finally {
      await runtime?.close();
      admission.close();
      registry.unregister("skill-connection");
      host?.restore();
    }
  },
);
