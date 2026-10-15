import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { expect } from "vitest";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

export type TypingE2eScenario = "child" | "child-yield" | "child-error" | "child-cancel";

export function resolveTypingE2eScenario(selection?: string): TypingE2eScenario {
  switch (selection) {
    case "child":
    case "child-error":
    case "child-cancel":
    case "child-yield":
      return selection;
    case "foundation":
      return "child";
    default:
      return "child-yield";
  }
}

export function createConfig(
  nonce: string,
  modelUrl: string,
  root: string,
  guildId: string,
  channelId: string,
): OpenClawConfig {
  const providerId = "typing-" + nonce;
  const modelId = "typing-" + nonce;
  const modelRef = providerId + "/" + modelId;
  return {
    plugins: { enabled: false },
    session: {
      mainKey: "main",
      scope: "per-sender",
      store: path.join(root, "discord-e2e-sessions.json"),
    },
    channels: {
      discord: {
        enabled: true,
        token: nonce,
        dmPolicy: "open",
        groupPolicy: "open",
        guilds: {
          [guildId]: {
            users: ["discord:333333333333333333"],
            channels: {
              [channelId]: {
                enabled: true,
                requireMention: false,
                users: ["discord:333333333333333333"],
              },
            },
          },
        },
      },
    },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        model: { primary: modelRef },
        models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
        workspace: path.join(root, "discord-e2e-workspace"),
        timeoutSeconds: 300,
        typingMode: "instant",
        typingIntervalSeconds: 6,
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: {
      codeMode: false,
      toolSearch: false,
      allow: ["sessions_spawn", "sessions_yield", "typing_fixture_wait"],
    },
    models: {
      mode: "replace",
      providers: {
        [providerId]: {
          baseUrl: modelUrl + "/v1",
          apiKey: nonce,
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: modelId,
              name: modelId,
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
}

export function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.once("error", reject);
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export function makeQuietToolPlugin(tracePath: string): string {
  return [
    'import { appendFile } from "node:fs/promises";',
    'export default { id: "typing-fixture", register(api) { api.registerTool({',
    'name: "typing_fixture_wait", label: "Typing Quiet Execution", description: "Execute a bounded quiet local task for a typing regression fixture.",',
    'parameters: { type: "object", properties: { label: { type: "string" }, durationMs: { type: "integer", minimum: 0, maximum: 320000 }, outcome: { type: "string", enum: ["success", "error"] } }, required: ["label", "durationMs"], additionalProperties: false },',
    'executionMode: "sequential", async execute(callId, args, signal) {',
    "const record = phase => appendFile(" +
      JSON.stringify(tracePath) +
      ', JSON.stringify({ phase, callId, label: args.label, at: Date.now(), pid: process.pid }) + "\\n");',
    'await record("start");',
    'try { await new Promise((resolve, reject) => { const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); }; const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason ?? Error("aborted")); }; const timer = setTimeout(finish, args.durationMs); if(signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true }); });',
    'await record("end"); if(args.outcome === "error") throw Error("typing fixture intentional error"); return { content: [{ type: "text", text: "QUIET_TASK_DONE_" + args.label }], details: {} };',
    '} catch(error) { await record("error"); throw error; }',
    "} }); } };",
  ].join("\n");
}

export function toolCallEvents(name: string, args: Record<string, unknown>, sequence: number) {
  const responseId = "resp_tool_" + sequence,
    itemId = "fc_tool_" + sequence;
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: "call_tool_" + sequence,
    name,
    arguments: argumentsText,
  };
  return [
    {
      type: "response.created",
      response: { id: responseId, object: "response", status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      arguments: argumentsText,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    },
  ];
}

export async function boundedWait(promise: Promise<void>, timeoutMs: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export type DiscordRestEvent = {
  path: string | undefined;
  authorization: string | undefined;
  at: number;
  body?: string;
  matchedExpectedSuccessorMarker?: boolean;
  responseStatus?: number;
  responseFinished?: boolean;
  responseFinishedAt?: number;
};

export function activeTypingWaitRole(
  scenario: string,
  event: { stream: string; data: Record<string, unknown> },
  isChild: boolean,
  successorStarted: boolean,
): "parent" | "child" | undefined {
  if (
    scenario !== "child" ||
    event.stream !== "tool" ||
    event.data.phase !== "start" ||
    event.data.name !== "typing_fixture_wait"
  ) {
    return undefined;
  }
  return isChild ? "child" : successorStarted ? undefined : "parent";
}

export type ProviderRouteEvidence = {
  at: number;
  route: "child" | "parent";
  completionPrompt: boolean;
  responseStatus?: number;
  responseFinishedAt?: number;
};

export async function emitTypingFailureEvidence(input: {
  scenario: string;
  caseStartedAt?: number;
  requesterReturnAt?: number;
  successorWaitStartedAt?: number;
  successorWaitTimeoutMs?: number;
  toolTracePath?: string;
  agentEvidence: Array<Record<string, unknown>>;
  terminalRuns: Array<Record<string, unknown>>;
  liveSamples: Array<Record<string, unknown>>;
  providerRoutes: ProviderRouteEvidence[];
  restEvents: DiscordRestEvent[];
}) {
  const relativeMs = (at: unknown) =>
    input.caseStartedAt === undefined || typeof at !== "number" ? null : at - input.caseStartedAt;
  const safePhase = (value: unknown) =>
    value === "start" || value === "end" || value === "error" ? value : "other";
  const toolTimes: Array<{ label: string; phase: string; at: unknown }> = [];
  if (input.toolTracePath) {
    try {
      const trace = await readFile(input.toolTracePath, "utf8");
      for (const line of trace.split("\n")) {
        if (!line) {
          continue;
        }
        const event = JSON.parse(line) as { label?: unknown; phase?: unknown; at?: unknown };
        if (
          ["child", "parent", "successor"].includes(String(event.label)) &&
          ["start", "end", "error"].includes(String(event.phase)) &&
          typeof event.at === "number"
        ) {
          toolTimes.push({ label: String(event.label), phase: String(event.phase), at: event.at });
        }
      }
    } catch {
      // The trace may be unavailable if fixture setup failed.
    }
  }
  const safeOwnerState = (value: unknown) =>
    ["active", "waiting", "none", "error", "requester-run-not-observed"].includes(String(value))
      ? String(value)
      : "other";
  const safeSampleLabel = (value: unknown) => {
    const labels = [
      "active-parent-and-child",
      "before-exact-child-cancel",
      "yielded-child-after-typing-expiry",
      "terminal-child-after-successor",
      "terminal-child-after-cancel",
    ];
    return labels.includes(String(value)) ? String(value) : "other";
  };
  const evidence = {
    scenario: input.scenario,
    clocksMs: {
      requesterReturn: relativeMs(input.requesterReturnAt),
      successorWaitStart: relativeMs(input.successorWaitStartedAt),
      successorWaitTimeout: input.successorWaitTimeoutMs ?? null,
      failureObserved: relativeMs(Date.now()),
    },
    toolTimesMs: toolTimes.slice(-12).map((event) => ({
      label: event.label,
      phase: event.phase,
      at: relativeMs(event.at),
    })),
    lifecycle: input.agentEvidence
      .filter((event) => event.stream === "lifecycle" || event.stream === "tool")
      .slice(-20)
      .map((event) => ({
        at: relativeMs(event.at),
        stream: event.stream === "lifecycle" ? "lifecycle" : "tool",
        phase: safePhase(event.phase),
        child: event.isChild === true,
        live: event.live === true,
        childLive: event.childLive === true,
        tool: ["typing_fixture_wait", "sessions_spawn", "sessions_yield"].includes(
          String(event.name),
        )
          ? String(event.name)
          : undefined,
        requesterSessionMatchesRequest: event.requesterSessionMatchesRequest === true,
        requesterAgentMatchesRequest: event.requesterAgentMatchesRequest === true,
        requesterTurnMatchesObservedRun: event.requesterTurnMatchesObservedRun === true,
      })),
    terminal: input.terminalRuns.slice(-8).map((event) => ({
      at: relativeMs(event.at),
      phase: safePhase(event.phase),
    })),
    wakeSamples: input.liveSamples.slice(-8).map((sample) => ({
      label: safeSampleLabel(sample.label),
      at: relativeMs(sample.at),
      childLive: sample.childLive === true,
      parentLive: sample.parentLive === true,
      requesterTurnYielded: sample.requesterTurnYielded === true,
      requesterSessionMatchesRequest: sample.requesterSessionMatchesRequest === true,
      requesterAgentMatchesRequest: sample.requesterAgentMatchesRequest === true,
      requesterTurnMatchesObservedRun: sample.requesterTurnMatchesObservedRun === true,
      directRequesterLineageObserved: sample.directRequesterLineageObserved === true,
      diagnosticOwnerState: safeOwnerState(sample.diagnosticOwnerState),
      yieldedPublicWakeOwner: sample.yieldedPublicWakeOwner === true,
      childSessionKey:
        typeof sample.childSessionKey === "string" ? sample.childSessionKey : undefined,
      settleWakeObserved: sample.requesterSettleWake !== undefined,
    })),
    providerRoutes: input.providerRoutes.slice(-12).map((event) => ({
      at: relativeMs(event.at),
      route: event.route,
      completionPrompt: event.completionPrompt,
      responseStatus: event.responseStatus ?? null,
      responseFinished: event.responseFinishedAt !== undefined,
      responseFinishAt: relativeMs(event.responseFinishedAt),
    })),
    discordMessages: input.restEvents
      .filter((event) => event.path?.endsWith("/messages"))
      .slice(-8)
      .map((event) => ({
        at: relativeMs(event.at),
        expectedMarkerMatched: event.matchedExpectedSuccessorMarker === true,
        responseStatus: event.responseStatus ?? null,
        responseFinished: event.responseFinished === true,
        responseFinishAt: relativeMs(event.responseFinishedAt),
      })),
  };
  process.stderr.write("[typing-e2e-failure] " + JSON.stringify(evidence) + "\n");
}

export function handleDiscordRest(
  request: IncomingMessage,
  response: ServerResponse,
  restNonce: string,
  events: DiscordRestEvent[],
  onPhase: (value: string) => void | Promise<void>,
  expectedSuccessorMarker: string | undefined,
  onSuccessorReply: () => void,
) {
  if (request.method === "GET" && request.url === "/api/v10/identity") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ nonce: restNonce, port: request.socket.localPort }));
    return;
  }
  const event: DiscordRestEvent = {
    path: request.url,
    authorization: request.headers.authorization,
    at: Date.now(),
  };
  events.push(event);
  response.once("finish", () => {
    event.responseStatus = response.statusCode;
    event.responseFinished = true;
    event.responseFinishedAt = Date.now();
  });
  response.once("close", () => {
    event.responseStatus ??= response.statusCode;
    event.responseFinished ??= response.writableFinished;
    event.responseFinishedAt ??= Date.now();
  });
  void onPhase("discord-rest-" + (request.url ?? "unknown"));
  if (request.headers.authorization !== "Bot " + restNonce) {
    response.writeHead(401).end();
    return;
  }
  if (request.method === "POST" && request.url?.endsWith("/typing")) {
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && request.url?.endsWith("/messages")) {
    void readBody(request).then((body) => {
      event.body = body;
      event.matchedExpectedSuccessorMarker =
        expectedSuccessorMarker !== undefined && body.includes(expectedSuccessorMarker);
      if (event.matchedExpectedSuccessorMarker) {
        onSuccessorReply();
      }
      void onPhase("discord-delivered-body-" + body);
      const responseChannelId = request.url?.split("/").at(-2) ?? "111111111111111111";
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "discord-e2e-message",
          channel_id: responseChannelId,
          content: JSON.parse(body).content ?? "",
        }),
      );
    });
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end("{}");
}

export async function abortOwnedChild(
  runId: string,
  expectedChildSessionKey: string,
  gatewayPort: number,
  token: string,
  assertTarget: (url: string) => void,
  sample: (label: string) => Promise<void>,
) {
  const { getSubagentRunByRunId } =
    await import("../../src/agents/subagents/registry/subagent-registry.js");
  const { isSubagentRunLive } =
    await import("../../src/agents/subagents/registry/subagent-run-liveness.js");
  const entry = getSubagentRunByRunId(runId);
  expect(entry?.childSessionKey).toBe(expectedChildSessionKey);
  expect(isSubagentRunLive(entry)).toBe(true);
  await sample("before-exact-child-cancel");
  const { connectGatewayClient, disconnectGatewayClient } =
    await import("../../src/gateway/test-helpers.e2e.js");
  const url = "ws://127.0.0.1:" + gatewayPort;
  assertTarget(url);
  const client = await connectGatewayClient({ url, token });
  try {
    const receipt = await client.request<{ aborted?: boolean }>("chat.abort", {
      sessionKey: expectedChildSessionKey,
      runId,
    });
    return receipt;
  } finally {
    await disconnectGatewayClient(client);
  }
}

export function createFixtureWebSocketGuard(
  allowedLoopbackPorts: Set<string>,
  blockedWebSocketTargets: string[],
  websocketTargets: string[],
) {
  return (url: string) => {
    const target = new URL(url);
    if (
      target.protocol !== "ws:" ||
      target.hostname !== "127.0.0.1" ||
      !allowedLoopbackPorts.has(target.port)
    ) {
      blockedWebSocketTargets.push(target.protocol + "//" + target.host);
      throw new Error("stage WebSocket blocked outside owned loopback fixture ports");
    }
    websocketTargets.push(target.protocol + "//" + target.host);
  };
}

type TypingOwnerDiagnosticState =
  | "active"
  | "waiting"
  | "none"
  | "error"
  | "requester-run-not-observed";
type TypingOwnerDiagnosticObserver = {
  currentState: () => "active" | "waiting" | "none";
  dispose: () => void;
};

export function createTypingOwnerDiagnostic() {
  let requesterSessionKey: string | undefined;
  let requesterAgentId: string | undefined;
  let requesterRunId: string | undefined;
  let observer: TypingOwnerDiagnosticObserver | undefined;
  let setup: Promise<void> | undefined;
  let state: TypingOwnerDiagnosticState | undefined;
  let directRequesterLineageObserved = false;

  const reset = () => {
    observer?.dispose();
    observer = undefined;
    setup = undefined;
    state = undefined;
    requesterSessionKey = undefined;
    requesterAgentId = undefined;
    requesterRunId = undefined;
    directRequesterLineageObserved = false;
  };

  return {
    reset,
    bindRequest: (sessionKey: string, agentId: string) => {
      requesterSessionKey = sessionKey;
      requesterAgentId = agentId;
    },
    observeAgentEvent: (
      event: { runId: string; sessionKey?: string; stream: string; phase?: unknown },
      entry?: SubagentRunRecord | null,
    ) => {
      if (
        !requesterRunId &&
        !entry &&
        event.sessionKey === requesterSessionKey &&
        event.stream === "tool" &&
        event.phase === "start"
      ) {
        requesterRunId = event.runId;
      }
      if (
        entry &&
        entry.requesterSessionKey === requesterSessionKey &&
        entry.requesterAgentId === requesterAgentId &&
        entry.requesterTurnRunId === requesterRunId
      ) {
        directRequesterLineageObserved = true;
      }
    },
    observeChildStart: (entry: SubagentRunRecord) => {
      if (setup) {
        return;
      }
      const runId =
        requesterRunId ??
        (entry.requesterSessionKey === requesterSessionKey &&
        entry.requesterAgentId === requesterAgentId
          ? entry.requesterTurnRunId
          : undefined);
      if (!requesterSessionKey || !runId) {
        state = "requester-run-not-observed";
        setup = Promise.resolve();
        return;
      }
      setup = import("../../src/auto-reply/reply/typing-background-work.runtime.js")
        .then(({ createReplyBackgroundWorkObserver }) => {
          observer = createReplyBackgroundWorkObserver({
            sessionKey: requesterSessionKey!,
            runId,
            onChange: (next) => {
              state = next;
            },
          });
          state = observer.currentState();
        })
        .catch(() => {
          state = "error";
        });
    },
    ready: () => setup ?? Promise.resolve(),
    sample: (entry: SubagentRunRecord) => {
      try {
        state = observer?.currentState() ?? state;
      } catch {
        state = "error";
      }
      return {
        requesterSessionMatchesRequest: entry.requesterSessionKey === requesterSessionKey,
        requesterAgentMatchesRequest: entry.requesterAgentId === requesterAgentId,
        requesterTurnMatchesObservedRun: entry.requesterTurnRunId === requesterRunId,
        directRequesterLineageObserved,
        diagnosticOwnerState: state ?? "not-started",
      };
    },
    dispose: () => {
      observer?.dispose();
      observer = undefined;
    },
  };
}

export function createLiveSubagentSampler(params: {
  agentEvidence: Array<Record<string, unknown>>;
  liveSamples: Array<Record<string, unknown>>;
  ownerDiagnostic: ReturnType<typeof createTypingOwnerDiagnostic>;
  recordPhase: (value: string) => Promise<void>;
}) {
  return async (label: string) => {
    const { getSubagentRunByRunId } =
      await import("../../src/agents/subagents/registry/subagent-registry.js");
    const { isSubagentRunLive } =
      await import("../../src/agents/subagents/registry/subagent-run-liveness.js");
    const { hasLiveAgentRunContext } = await import("../../src/infra/agent-run-registry.js");
    const ids = [...new Set(params.agentEvidence.map((event) => String(event.runId)))];
    for (const id of ids) {
      const child = getSubagentRunByRunId(id);
      if (!child) {
        continue;
      }
      params.liveSamples.push({
        label,
        at: Date.now(),
        runId: id,
        childLive: isSubagentRunLive(child),
        parentLive: child.requesterTurnRunId
          ? hasLiveAgentRunContext(child.requesterTurnRunId)
          : false,
        requesterTurnRunId: child.requesterTurnRunId,
        requesterTurnYielded: child.requesterTurnYielded === true,
        yieldedPublicWakeOwner:
          child.requesterSettleWake?.requesterYieldBatch === true &&
          child.requesterSettleWake.yieldedFinalDeliverable === true &&
          child.requesterSettleWake.batchRunIds?.includes(child.runId) === true,
        ...params.ownerDiagnostic.sample(child),
        childSessionKey: child.childSessionKey,
        execution: child.execution,
        requesterSettleWake: child.requesterSettleWake,
      });
    }
    await params.recordPhase("sample-live-" + label);
  };
}
