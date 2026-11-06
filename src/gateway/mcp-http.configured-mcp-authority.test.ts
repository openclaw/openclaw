import "../test-utils/prepare-compiled-subprocesses.js";
import http from "node:http";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  listenLoopback,
  closeHttpServer,
  readRequestText,
  respondJson,
} from "../../test/helpers/gateway-integration-fixtures.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { setSessionMcpRuntimeScheduler } from "../agents/agent-bundle-mcp-manager-api.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { buildDefaultTestCliBackend } from "../agents/cli-runner.test-helpers.js";
import { prepareCliRunContext } from "../agents/cli-runner/prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../agents/cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { activateWorkshopPluginForTest } from "../skills/test-support/workshop-plugin.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { revokeMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import * as mcp from "./mcp-http.test-support.js";

// Guidance past the old 1,200-character metadata cap must still reach Claude.
const PROBE_INSTRUCTIONS = "Probe usage guidance. ".repeat(80) + "PROBE_TAIL: one word per call.";

type ProbeMessage = {
  id?: number | string;
  method?: string;
  params?: {
    protocolVersion?: string;
    arguments?: { word?: string };
    uri?: string;
    name?: string;
  };
};

function probeResult(message: ProbeMessage): Record<string, unknown> {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        serverInfo: { name: "probe", version: "1" },
        instructions: PROBE_INSTRUCTIONS,
      };
    case "tools/list":
      return {
        tools: [
          {
            name: "echo",
            description: "Echo a word.",
            inputSchema: { type: "object", properties: { word: { type: "string" } } },
          },
        ],
      };
    case "tools/call":
      return { content: [{ type: "text", text: "probe:" + message.params?.arguments?.word }] };
    case "resources/list":
      return { resources: [{ uri: "probe://note", name: "note" }] };
    case "resources/read":
      return { contents: [{ uri: message.params?.uri, text: "resource:" + message.params?.uri }] };
    case "prompts/list":
      return { prompts: [{ name: "greet" }] };
    case "prompts/get":
      return {
        messages: [
          { role: "user", content: { type: "text", text: "prompt:" + message.params?.name } },
        ],
      };
    default:
      return {};
  }
}

/** Real streamable-HTTP MCP server with tools, resources and prompts. */
async function startProbeServer() {
  const counts: Record<string, number> = {};
  const state: { onToolsList?: () => Promise<void> } = {};
  const streams = new Set<http.ServerResponse>();
  // Client responses to server-initiated pings, keyed by request id.
  const pendingPings = new Map<string, () => void>();
  let pingId = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method === "GET") {
        // Standalone SSE stream for server-initiated notifications.
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        streams.add(response);
        response.on("close", () => streams.delete(response));
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(request.method === "DELETE" ? 200 : 405).end();
        return;
      }
      const message = JSON.parse(await readRequestText(request)) as ProbeMessage;
      if (message.method === undefined) {
        // Response to a server-initiated request.
        pendingPings.get(String(message.id))?.();
        response.writeHead(202).end();
        return;
      }
      counts[message.method] = (counts[message.method] ?? 0) + 1;
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "initialize") {
        response.setHeader("mcp-session-id", "probe-session");
      } else if (message.method === "tools/list") {
        const hook = state.onToolsList;
        state.onToolsList = undefined;
        // Runs while OpenClaw awaits the catalog refresh, after the loopback
        // handler already admitted the call.
        await hook?.();
      }
      respondJson(response, { jsonrpc: "2.0", id: message.id, result: probeResult(message) });
    })().catch(() => response.writeHead(500).end());
  });
  const port = Number(new URL(await listenLoopback(server)).port);
  return {
    port,
    counts,
    state,
    /**
     * Server-initiated tools/list_changed: OpenClaw refreshes before the next call.
     * A ping follows on each stream; a client handles stream messages in order,
     * so every ping reply proves that client consumed the notification.
     */
    notifyToolsChanged: async () => {
      expect(streams.size).toBeGreaterThan(0);
      await Promise.all(
        [...streams].map(async (stream) => {
          const id = "probe-ping-" + ++pingId;
          const answered = new Promise<void>((resolve) => {
            pendingPings.set(id, resolve);
          });
          for (const frame of [
            { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
            { jsonrpc: "2.0", id, method: "ping" },
          ]) {
            stream.write("event: message\ndata: " + JSON.stringify(frame) + "\n\n");
          }
          await answered;
          pendingPings.delete(id);
        }),
      );
    },
    close: async () => {
      await closeHttpServer(server);
    },
  };
}

let state: OpenClawTestState;
let config: OpenClawConfig;
let probe: Awaited<ReturnType<typeof startProbeServer>>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let resetWorkshopPlugin: (() => void) | undefined;
const contexts: PreparedCliRunContext[] = [];
const admissions: PreparedAgentRunAdmission[] = [];

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-mcp-configured-authority-",
    layout: "state-only",
    env: { OPENCLAW_TEST_FAST: "0", OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" },
  });
  probe = await startProbeServer();
  config = {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "claude-cli/sonnet" },
      },
      entries: {
        main: { workspace: state.workspaceDir },
        // Same workspace, but every session runs sandboxed.
        sbx: { workspace: state.workspaceDir, sandbox: { mode: "all" } },
        // Sandboxed, with Workshop named in the sandbox tool policy.
        sbxw: {
          workspace: state.workspaceDir,
          sandbox: { mode: "all" },
          tools: { sandbox: { tools: { alsoAllow: ["skill_workshop"] } } },
        },
      },
    },
    plugins: { enabled: true, allow: ["skill-workshop"] },
    skills: { load: { watch: false } },
    tools: {
      allow: ["read", "probe__*", "skill_workshop", "skill_library"],
      codeMode: false,
      toolSearch: false,
    },
    mcp: {
      servers: {
        probe: { transport: "streamable-http", url: "http://127.0.0.1:" + probe.port + "/mcp" },
      },
    },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  openOpenClawStateDatabase();
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...buildDefaultTestCliBackend({ bundleMcp: true }),
        id: "claude-cli",
        autoSelectAuthProfile: false,
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "execution-args",
        resolveExecutionArgs: ({ baseArgs }) => baseArgs,
      },
    ],
  });
  mcp.setMinimalCliPrepareDeps(setCliRunnerPrepareTestDeps);
  scheduler = createTestGatewayScheduler();
  await setSessionMcpRuntimeScheduler(scheduler);
  await ensureMcpLoopbackServer();
});

beforeEach(async () => {
  resetWorkshopPlugin = (await activateWorkshopPluginForTest(config)).reset;
});

afterEach(async () => {
  resetWorkshopPlugin?.();
  await closeSkillsWatchers(true);
});

afterAll(async () => {
  for (const context of contexts) {
    await context.preparedBackend.cleanup?.();
  }
  for (const admission of admissions) {
    admission.close();
  }
  await disposeAllSessionMcpRuntimes();
  await scheduler?.stop();
  await closeMcpLoopbackServer();
  await probe?.close();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  await state?.cleanup();
});

/** Prepares a real CLI turn and returns a client bound to its loopback grant. */
async function prepareTurn(
  name: string,
  completion: boolean,
  signal: AbortSignal,
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability,
  agentId = "main",
) {
  const sessionId = "configured-" + name;
  const sessionKey = "agent:" + agentId + ":" + sessionId;
  const childSessionKey = "agent:" + agentId + ":subagent:" + sessionId;
  const childEntry = (spawnedBy: string) => ({
    sessionId: sessionId + "-child",
    updatedAt: Date.now(),
    spawnedBy,
    spawnDepth: 1,
    inheritedToolPolicyVersion: 1 as const,
    inheritedToolAllow: ["read", "probe__*", "skill_workshop", "skill_library"],
  });
  const entry = {
    sessionId,
    updatedAt: Date.now(),
    sessionStartedAt: Date.now(),
    permissionMode: "full" as const,
  };
  await replaceSessionEntry({ agentId, sessionKey }, entry);
  if (completion) {
    await replaceSessionEntry({ agentId, sessionKey: childSessionKey }, childEntry(sessionKey));
  }
  const runId = sessionId + "-run";
  const admission = prepareSystemAgentRunAdmission(config, runId, agentId, "configured-mcp-test");
  admissions.push(admission);
  const context = await prepareCliRunContext({
    preparedRunAdmission: admission,
    config,
    agentId,
    sessionKey,
    sessionId,
    sessionEntry: entry,
    sessionTarget: {
      agentId,
      sessionKey,
      sessionId,
      storePath: resolveSessionStorePathCore(config.session?.store, { agentId }),
    },
    sessionFile: state.path(sessionId + ".jsonl"),
    workspaceDir: state.workspaceDir,
    cwd: state.workspaceDir,
    provider: "claude-cli",
    model: "sonnet",
    modelHasVision: false,
    prompt: "Use the probe server.",
    skillsSnapshot: { prompt: "", skills: [] },
    senderIsOwner: true,
    ...(skillLibraryAuthoring ? { skillLibraryAuthoring } : {}),
    runId,
    timeoutMs: 60_000,
    abortSignal: signal,
    ...(completion
      ? {
          trustedInternalHandoff: {
            kind: "subagent-completion" as const,
            sourceSessionKey: childSessionKey,
            sourceSessionId: sessionId + "-child",
            targetSessionKey: sessionKey,
            targetSessionId: sessionId,
            provider: "claude-cli",
            model: "sonnet",
          },
          inputProvenance: {
            kind: "inter_session" as const,
            sourceTool: "subagent_announce",
            sourceSessionKey: childSessionKey,
          },
        }
      : {}),
  });
  contexts.push(context);
  const { token, rpc } = await mcp.connectPreparedCliTurn(context, signal);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const response = await rpc("tools/call", { name: tool, arguments: args });
    expect(response.status).toBe(200);
    const result = expectDefined(response.body.result, tool + " result");
    return {
      isError: result.isError === true,
      text: (result.content ?? []).map((block) => block.text ?? "").join("\n"),
    };
  };
  return {
    rpc,
    call,
    // The real grant store revokes the minted token.
    revoke: async () => {
      expect(revokeMcpLoopbackClientGrant(token)).toBe(true);
    },
    // The child's persisted completion lineage moves to a different requester.
    reassign: async () => {
      await replaceSessionEntry(
        { agentId, sessionKey: childSessionKey },
        childEntry("agent:" + agentId + ":someone-else"),
      );
    },
  };
}

const OPERATIONS = [
  { tool: "probe__echo", args: { word: "pong" }, method: "tools/call", text: "probe:pong" },
  {
    tool: "probe__resources_read",
    args: { uri: "probe://note" },
    method: "resources/read",
    text: "resource:probe://note",
  },
  {
    tool: "probe__prompts_get",
    args: { name: "greet" },
    method: "prompts/get",
    text: "prompt:greet",
  },
];

async function workshopDefinition(
  turn: Awaited<ReturnType<typeof prepareTurn>>,
  name = "skill_workshop",
) {
  const listed = await turn.rpc("tools/list");
  expect(listed.status).toBe(200);
  return expectDefined(listed.body.result?.tools, "MCP catalog").find((tool) => tool.name === name);
}

it("serves complete configured-server instructions", async ({ signal }) => {
  const turn = await prepareTurn("allowed", false, signal);
  const initialized = await turn.rpc("initialize", {});
  expect(initialized.body.result?.instructions).toBe("## probe\n" + PROBE_INSTRUCTIONS);
});

it.for(
  OPERATIONS.flatMap((operation) => [
    { ...operation, change: "revoked grant", completion: false },
    { ...operation, change: "reassigned completion lineage", completion: true },
  ]),
)(
  "refuses $tool before server I/O after a $change during a catalog refresh",
  async (operation, { signal }) => {
    const turn = await prepareTurn(
      operation.tool + (operation.completion ? "-lineage" : "-revoked"),
      operation.completion,
      signal,
    );
    expect(await turn.call(operation.tool, operation.args)).toEqual({
      isError: false,
      text: expect.stringContaining(operation.text),
    });
    // The next call now waits on a catalog refresh from the server.
    await probe.notifyToolsChanged();
    const before = { ...probe.counts };
    probe.state.onToolsList = operation.completion ? turn.reassign : turn.revoke;
    expect(await turn.call(operation.tool, operation.args)).toEqual({
      isError: true,
      text: expect.stringContaining("Tool call authorization expired"),
    });
    // The refresh ran; the refused request never reached the server.
    expect(probe.counts["tools/list"]).toBe((before["tools/list"] ?? 0) + 1);
    expect(probe.counts[operation.method]).toBe(before[operation.method]);
  },
);

it.for(["personal", "workspace"] as const)(
  "keeps %s-default skill definitions on a completion turn without its authority",
  async (defaultTarget, { signal }) => {
    const personalCalls: unknown[] = [];
    const human: SkillLibraryAuthoringCapability = {
      target: "personal",
      defaultTarget,
      multipleProfiles: true,
      bind: () => {},
      invoke: async (input) => {
        personalCalls.push(input);
        return { skills: [] } as never;
      },
    };
    const name = "workshop-" + defaultTarget;
    const humanTurn = await prepareTurn(name, false, signal, human);
    const humanDefinitions = {
      library: await workshopDefinition(humanTurn, "skill_library"),
      workshop: await workshopDefinition(humanTurn),
    };
    const completionTurn = await prepareTurn(name, true, signal);
    expect(humanDefinitions.library).toBeDefined();
    expect(humanDefinitions.workshop !== undefined).toBe(defaultTarget === "workspace");
    // Same definitions on the completion turn keep Claude's cached prefix.
    expect({
      library: await workshopDefinition(completionTurn, "skill_library"),
      workshop: await workshopDefinition(completionTurn),
    }).toEqual(humanDefinitions);
    // Personal-library calls need a fresh human message; the live grant is not reached.
    expect(await completionTurn.call("skill_library", { action: "list" })).toEqual({
      isError: true,
      text: expect.stringContaining("needs a fresh message from the person"),
    });
    expect(personalCalls).toEqual([]);
    if (defaultTarget === "workspace") {
      // Unsandboxed workspace Workshop calls keep the ordinary no-grant rule.
      expect((await completionTurn.call("skill_workshop", { action: "list" })).isError).toBe(false);
    }
  },
);

it.for([
  { agentId: "sbx", policy: "default sandbox tool policy" },
  { agentId: "sbxw", policy: "sandbox policy allowing skill_workshop" },
])(
  "refuses a sandboxed completion's workspace Workshop write under the $policy",
  async ({ agentId }, { signal }) => {
    const human: SkillLibraryAuthoringCapability = {
      target: "personal",
      defaultTarget: "workspace",
      multipleProfiles: false,
      bind: () => {},
      invoke: async () => {
        throw new Error("the human grant must not be reached");
      },
    };
    const create = {
      action: "create",
      name: "sandbox-probe",
      content: "---\nname: sandbox-probe\ndescription: Probe\n---\n\n1. Run it.\n",
    };
    const snapshot = async () =>
      (await listDirectoryTreeStrict(state.workspaceDir))
        .map((walkEntry) => walkEntry.relativePath)
        .map(String)
        .toSorted();
    const before = await snapshot();
    const name = "workshop-" + agentId;
    const humanDefinition = await workshopDefinition(
      await prepareTurn(name, false, signal, human, agentId),
    );
    const completionTurn = await prepareTurn(name, true, signal, undefined, agentId);
    // The plugin withholds Workshop in sandboxed runs even when tool policy allows it.
    expect(await workshopDefinition(completionTurn)).toEqual(humanDefinition);
    expect(humanDefinition).toBeUndefined();
    expect(await completionTurn.call("skill_workshop", create)).toEqual({
      isError: true,
      text: "Tool not available: skill_workshop",
    });
    expect(await snapshot()).toEqual(before);
  },
);
