import "./tools-effective.test-support.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import { assertSessionEventTargetCurrent } from "../../auto-reply/reply/session-event-target.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionActor } from "../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { NODE_CLAUDE_SKILLS_CAPABILITY } from "../../infra/node-claude-skill-protocol.js";
import { NODE_AGENT_CLI_CLAUDE_RUN_COMMAND } from "../../infra/node-commands.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { resolveNodeHostGatewayPlatformIdentity } from "../../node-host/gateway-platform-identity.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
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

const { cfg, enqueueEvent, prepareRegistry, ingress } = vi.hoisted(() => ({
  cfg: {
    agents: { entries: { main: {}, native: {}, sibling: {} } },
    gateway: { terminal: { enabled: true } },
  },
  enqueueEvent:
    vi.fn<
      typeof import("../../auto-reply/reply/session-event-handoff.js").enqueueSessionEventForHost
    >(),
  ingress: vi.fn(async () => {}),
  prepareRegistry: vi.fn(async () => false),
}));
// mock-isolation: Exercise Gateway admission and actor persistence without running a model turn.
vi.mock("../../commands/agent.js", () => ({ agentCommandFromIngress: ingress }));
// mock-isolation: Keep real target capture and authority checks; stop before model execution.
vi.mock("../../auto-reply/reply/session-event-handoff.js", async (original) => ({
  ...(await original<typeof import("../../auto-reply/reply/session-event-handoff.js")>()),
  enqueueSessionEventForHost: enqueueEvent,
}));
vi.mock("../../agents/subagents/registry/subagent-registry-state.js", async (original) => ({
  ...(await original<
    typeof import("../../agents/subagents/registry/subagent-registry-state.js")
  >()),
  prepareOptionalSubagentSessionListReadCache: prepareRegistry,
}));

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
const context = createGatewayRequestContext(makeContextParams());
context.getRuntimeConfig = () => cfg;
context.getCommittedRuntimeConfig = () => cfg;
context.publishPresence = vi.fn();

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
  setRuntimeConfigSnapshot(cfg, cfg);
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  setRuntimeConfigSnapshot(cfg, cfg);
  enqueueEvent.mockReset().mockImplementation((_text, options) => {
    options.assertAcceptanceCurrent?.();
    if (options.expectedTarget) {
      assertSessionEventTargetCurrent(options.expectedTarget);
    }
    return {
      id: "incognito-control-event",
      cancel: () => false,
      accepted: Promise.resolve({ ok: true }),
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
    };
  });
});
afterEach(() => {
  testing.resetToolsEffectiveCacheForTest();
  toolsEffectiveInventoryMocks.resolveEffectiveToolInventory.mockClear();
  ingress.mockClear();
  resetSystemEventsForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await actor?.close();
  await closeOpenClawAgentDatabasesAsync();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "guards actor tool disclosure after catalogue preparation (replaced=%s)",
  async (replaced) => {
    const sessionKey = `agent:main:dashboard:incognito-tools-${replaced}`;
    const entry: SessionEntry = {
      sessionId: `tools-${replaced}`,
      updatedAt: Date.now(),
      incognito: true,
      model: "gpt-4.1",
      modelProvider: "openai",
    };
    await actor.sessions.create(authority, { sessionKey, entry });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    toolsEffectiveInventoryMocks.resolveEffectiveToolInventory.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { agentId: "main", profile: "coding", groups: [] };
    });
    const options = request("tools.effective", { agentId: "main", sessionKey });
    const host = observeHostDataSql();
    try {
      await withIncognitoSessionActor(actor, async () => {
        const pending = Promise.resolve(toolsEffectiveHandlers["tools.effective"]!(options));
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
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
          release.resolve();
          await pending;
        }
      });
      expect(options.respond).toHaveBeenCalledWith(
        !replaced,
        replaced ? undefined : expect.objectContaining({ groups: [] }),
        replaced ? expect.any(Object) : undefined,
      );
      expect(host.queries).toEqual([]);
    } finally {
      release.resolve();
      host.restore();
    }
  },
);

it("refuses terminal ownership after its actor session is replaced during catalogue preparation", async () => {
  const sessionKey = "agent:main:dashboard:incognito-terminal";
  const entry: SessionEntry = {
    sessionId: "terminal-source",
    updatedAt: Date.now(),
    incognito: true,
  };
  await actor.sessions.create(authority, { sessionKey, entry });
  const entered = createDeferredCore();
  const release = createDeferredCore();
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
  await withIncognitoSessionActor(actor, async () => {
    const pending = openTerminalSession(options, {
      agentId: "main",
      sessionKey,
      cols: 80,
      rows: 24,
      resolveCatalogPlan: async () => {
        entered.resolve();
        await release.promise;
        return { kind: "local", argv: ["synthetic-shell"], cwd: "/synthetic" };
      },
    });
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Terminal settled before catalogue preparation",
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        { ...entry, sessionId: "replacement" },
      );
    } finally {
      release.resolve();
      await settled;
    }
    await expect(pending).rejects.toThrow(/session|generation|snapshot/i);
  });
  expect(open).not.toHaveBeenCalled();
  manager.disposeAll();
});

it("routes actor system wakes and parent approval audiences without host SQL", async () => {
  const parent = "agent:sibling:dashboard:incognito-control-parent";
  const grandparent = "agent:main:dashboard:incognito-control-grandparent";
  const child = "agent:main:dashboard:incognito-control-child";
  const sibling = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "sibling",
    env,
    authority,
  });
  assert(sibling);
  await actor.sessions.create(authority, {
    sessionKey: grandparent,
    entry: { sessionId: "grandparent", updatedAt: Date.now(), incognito: true },
  });
  await sibling.sessions.create(authority, {
    sessionKey: parent,
    entry: {
      sessionId: "parent",
      updatedAt: Date.now(),
      incognito: true,
      parentSessionKey: grandparent,
    },
  });
  await actor.sessions.create(authority, {
    sessionKey: child,
    entry: { sessionId: "child", updatedAt: Date.now(), incognito: true, parentSessionKey: parent },
  });
  const options = request("system-event", {
    text: "Synthetic wake",
    sessionKey: child,
    wake: true,
  });
  const host = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      await systemHandlers["system-event"]!(options);
      expect(await resolveApprovalSessionAudienceWithFallback(child, "main")).toEqual([
        child,
        parent,
        grandparent,
      ]);
    });
    expect(options.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(peekSystemEvents(child)).toEqual([]);
    expect(enqueueEvent).toHaveBeenCalledExactlyOnceWith(
      "Synthetic wake",
      expect.objectContaining({
        source: "session",
        agentId: "main",
        sessionKey: child,
        expectedTarget: expect.objectContaining({ sessionId: "child" }),
      }),
    );
    expect(host.queries).toEqual([]);
  } finally {
    host.restore();
    await sibling.close();
  }
});

it("rejects a replaced actor source during approval lineage preparation", async () => {
  const sessionKey = "agent:main:dashboard:incognito-approval-replaced";
  const entry: SessionEntry = {
    sessionId: "approval-source",
    updatedAt: Date.now(),
    incognito: true,
  };
  await actor.sessions.create(authority, { sessionKey, entry });
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  prepareRegistry.mockImplementationOnce(async () => {
    entered.resolve();
    await finish.promise;
    return false;
  });
  await withIncognitoSessionActor(actor, async () => {
    const pending = resolveApprovalSessionAudienceWithFallback(sessionKey, "main");
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Approval lineage settled before registry preparation",
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        { ...entry, sessionId: "successor" },
      );
    } finally {
      finish.resolve();
      await settled;
    }
    await expect(pending).rejects.toThrow(/generation|current/);
  });
});

it.each(["agent:native:dashboard:incognito-native-controls", "agent:native:controls"])(
  "preserves unbound native wake %s without actor allocation",
  async (sessionKey) => {
    replaceSessionEntrySync(
      { agentId: "native", sessionKey },
      { sessionId: sessionKey, updatedAt: 1 },
    );
    const before = captureOpenClawAgentDatabaseExecution.listIncognito(env);
    const options = request("system-event", { text: "Native wake", sessionKey, wake: true });
    await systemHandlers["system-event"]!(options);
    expect(options.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(enqueueEvent).toHaveBeenCalledExactlyOnceWith(
      "Native wake",
      expect.objectContaining({
        source: "session",
        agentId: "native",
        sessionKey,
        expectedTarget: expect.objectContaining({ sessionId: sessionKey }),
      }),
    );
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual(before);
  },
);

it("joins accepted actor node work, preserves changed session settings, and canonicalizes subscriptions without host SQL", async () => {
  const sessionKey = "agent:main:dashboard:incognito-node-event";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "node-event", updatedAt: Date.now(), incognito: true, sendPolicy: "allow" },
  });
  const selected = createDeferredCore();
  const continueAdmission = createDeferredCore();
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  let connectionChecks = 0;
  ingress.mockImplementationOnce(async () => {
    entered.resolve();
    await finish.promise;
  });
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
    await withIncognitoSessionActor(actor, async () => {
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
                  selected.resolve();
                  await continueAdmission.promise;
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
          selected.promise,
          pending,
          "Node event settled before session selection",
        );
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { sendPolicy: "deny", thinkingLevel: "high", systemSent: true },
        );
        continueAdmission.resolve();
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Node event settled before ingress admission",
        );
        expect(settled).toBe(false);
      } finally {
        continueAdmission.resolve();
        finish.resolve();
        await pending;
      }
      expect((await actor.sessions.read(authority, { sessionKey })).entry).toMatchObject({
        sendPolicy: "deny",
        thinkingLevel: "high",
        systemSent: true,
      });
      await handleNodeEvent(nodeContext, "synthetic-node", {
        event: "chat.subscribe",
        payloadJSON: JSON.stringify({ sessionKey }),
      });
    });
    expect(ingress).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, sessionId: "node-event" }),
      expect.anything(),
      expect.anything(),
    );
    expect(subscribe).toHaveBeenCalledWith("synthetic-node", sessionKey, undefined);
    expect(host.queries).toEqual([]);
  } finally {
    continueAdmission.resolve();
    finish.resolve();
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
    const entry: SessionEntry = {
      sessionId: "node-skills",
      updatedAt: Date.now(),
      incognito: sourceKind === "actor" ? true : undefined,
      execHost: "node" as const,
      execNode: "skill-node",
      execCwd: "/synthetic",
    };
    if (sourceKind === "actor") {
      await actor.sessions.create(authority, { sessionKey, entry });
    } else {
      await upsertSessionEntryCore({ agentId, sessionKey }, entry);
    }
    const withSource = <T>(operation: () => Promise<T>) =>
      sourceKind === "actor" ? withIncognitoSessionActor(actor, operation) : operation();
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
      await withSource(() =>
        withPluginRuntimeGatewayRequestScope(
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
        ),
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
