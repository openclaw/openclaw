import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { text as readBody } from "node:stream/consumers";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import { createDeferred } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../helpers/tls-fixture.js";
import { isolatedGatewayEnv, messageText } from "./gateway-recovery.test-support.js";

const MODEL_ID = "qa-session-steering";
const SUMMARY_INSTRUCTIONS =
  /context summarization assistant[\s\S]*structured summary[\s\S]*do not continue/i;
const TITLE_INSTRUCTIONS = "Generate a concise session title";

type ProviderInputItem = {
  role?: string;
  type?: string;
  call_id?: string;
  output?: string;
  content?: unknown;
};
export type ProviderRequest = { instructions?: string; input: ProviderInputItem[] };
/** Returning "repeat" keeps the same turn at the head of the script for the next request. */
type ModelTurn = (request: ProviderRequest, response: ServerResponse) => Promise<void | "repeat">;

/** User-authored text the model actually received, in input order. */
export function userTexts(request: ProviderRequest): string[] {
  return request.input
    .filter((item) => item.role === "user")
    .map((item) => messageText(item as { content?: unknown }));
}

let responseSequence = 0;
export function replyText(response: ServerResponse, text: string): void {
  responseSequence += 1;
  writeOpenAiResponsesText(response, {
    text,
    messageId: `message-${responseSequence}`,
    responseId: `response-${responseSequence}`,
  });
}

export function writeToolCall(
  response: ServerResponse,
  name: string,
  args: Record<string, unknown>,
): void {
  responseSequence += 1;
  const item = {
    type: "function_call",
    id: `fc_${responseSequence}`,
    call_id: `call_${responseSequence}`,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${responseSequence}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

/**
 * Keeps the run working through real tool boundaries until the model receives
 * `marker`, then answers. This waits on what the runtime delivered to the model
 * rather than on time; `maxBoundaries` bounds a run that never delivers it.
 */
export function workUntilSeen(marker: string, answer: string, maxBoundaries = 200) {
  let boundaries = 0;
  const seen = createDeferred<number>();
  const turn: ModelTurn = async (request, response) => {
    if (userTexts(request).some((text) => text.includes(marker))) {
      seen.resolve(boundaries);
      replyText(response, answer);
      return undefined;
    }
    boundaries += 1;
    if (boundaries > maxBoundaries) {
      replyText(response, `Never received: ${marker}`);
      return undefined;
    }
    writeToolCall(response, "session_status", {});
    return "repeat";
  };
  return { turn, seen: seen.promise, boundaries: () => boundaries };
}

export function writeContextOverflow(response: ServerResponse): void {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "This model's maximum context length was exceeded.",
      },
    }),
  );
}

/**
 * A scripted OpenAI Responses model. Each agent request takes the next scripted
 * turn; title and compaction-summary requests are answered separately.
 */
async function startScriptedModel() {
  const requests: ProviderRequest[] = [];
  const turns: ModelTurn[] = [];
  // Concurrent conversations route by a marker in their user input instead of arrival order.
  const routes: Array<{ marker: string; turns: ModelTurn[] }> = [];
  const watchers = new Set<() => void>();
  const failures: Error[] = [];
  let summaryTurn: ModelTurn | undefined;
  let summaryRequests = 0;
  const server = await startOpenAiResponsesModelServer({
    modelId: MODEL_ID,
    bindError: "session steering model did not bind",
    onRequest: async (request, response) => {
      const body = JSON.parse(await readBody(request)) as ProviderRequest;
      const instructions = JSON.stringify([
        body.instructions,
        ...body.input.filter((item) => item.role === "developer" || item.role === "system"),
      ]);
      if (instructions.includes(TITLE_INSTRUCTIONS)) {
        replyText(response, "Session steering proof");
        return;
      }
      if (SUMMARY_INSTRUCTIONS.test(instructions)) {
        summaryRequests += 1;
        await (
          summaryTurn ?? (async (_body, res) => replyText(res, "## Decisions\n- Summarized."))
        )(body, response);
        return;
      }
      requests.push(body);
      for (const watcher of watchers) {
        watcher();
      }
      const routed = routes.find((route) =>
        userTexts(body).some((text) => text.includes(route.marker)),
      );
      const queue = routed?.turns ?? turns;
      const turn = queue.shift();
      if (!turn) {
        const error = new Error(`Unscripted model request: ${userTexts(body).join(" | ")}`);
        failures.push(error);
        throw error;
      }
      if ((await turn(body, response)) === "repeat") {
        queue.unshift(turn);
      }
    },
  });
  return {
    baseUrl: server.baseUrl,
    requests,
    failures,
    get summaryRequests() {
      return summaryRequests;
    },
    /** Queue the next agent-request responses, in order. */
    script(...next: ModelTurn[]) {
      turns.push(...next);
    },
    onSummary(turn: ModelTurn) {
      summaryTurn = turn;
    },
    /** Resolves with the first value `select` finds, checking again on each request. */
    whenRequest(select: () => ProviderRequest | undefined) {
      return new Promise<ProviderRequest>((resolve) => {
        const check = () => {
          const found = select();
          if (found) {
            watchers.delete(check);
            resolve(found);
          }
        };
        watchers.add(check);
        check();
      });
    },
    /** Scripts responses for requests whose user input contains `marker`. */
    route(marker: string, ...next: ModelTurn[]) {
      routes.push({ marker, turns: next });
    },
    pendingTurns: () => turns.length + routes.reduce((sum, route) => sum + route.turns.length, 0),
    /** Drops unrequested turns so one scenario's leftovers cannot answer the next. */
    clearTurns: () =>
      turns.splice(0).length +
      // Routes stay registered: a late request from a finished conversation must fail as
      // unscripted rather than consume another scenario's turns.
      routes.reduce((sum, route) => sum + route.turns.splice(0).length, 0),
    close: server.close,
  };
}
type ScriptedModel = Awaited<ReturnType<typeof startScriptedModel>>;

/** A turn that holds the response open until `release` resolves, then replies. */
function heldReply(text: string) {
  const entered = createDeferred();
  const release = createDeferred();
  const turn: ModelTurn = async (_request, response) => {
    entered.resolve();
    await release.promise;
    replyText(response, text);
  };
  return { turn, entered: entered.promise, release: () => release.resolve() };
}

export const reply =
  (text: string): ModelTurn =>
  async (_request, response) =>
    replyText(response, text);

type GatewayEvent = { event?: string; payload?: unknown };
type AgentEventPayload = {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: { phase?: string; [key: string]: unknown };
};

function agentEvents(events: GatewayEvent[]): AgentEventPayload[] {
  return events.flatMap((event) =>
    event.event === "agent" && event.payload && typeof event.payload === "object"
      ? [event.payload as AgentEventPayload]
      : [],
  );
}

/**
 * Run ids that executed in this session, in first-seen order. Followup runs skip the
 * lifecycle "start" phase, so any lifecycle event counts as execution.
 */
function executedRunIds(events: GatewayEvent[], sessionKey: string): string[] {
  return [
    ...new Set(
      agentEvents(events)
        .filter((event) => event.sessionKey === sessionKey && event.stream === "lifecycle")
        .map((event) => event.runId ?? ""),
    ),
  ];
}

type HistoryMessage = { role?: string; content?: unknown };
type ChatHistory = {
  sessionId?: string;
  messages: HistoryMessage[];
  pendingInputs?: unknown[];
};

const OPERATOR_SCOPES = ["operator.admin", "operator.read", "operator.write"] as const;
const CONTROL_UI = {
  clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
  scopes: [...OPERATOR_SCOPES],
};

type ChatSendResult = { runId: string; status?: string };
type RunResult = { status?: string; error?: string };
type ChatEventPayload = {
  runId?: string;
  state?: string;
  message?: { content?: unknown };
};

/** Configuration every steering Gateway shares: the scripted model and prompt queue admission. */
function applySteeringConfig(config: OpenClawConfig, model: ScriptedModel): OpenClawConfig {
  const scripted = createOpenAiResponsesModelConfig({
    baseUrl: model.baseUrl,
    providerId: "mock-openai",
    modelId: MODEL_ID,
    reasoning: false,
    toolProfile: "full",
  });
  return {
    ...config,
    plugins: { enabled: false, slots: { memory: "none" } },
    models: scripted.models,
    tools: { ...config.tools, profile: "full", toolSearch: { enabled: false } },
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        ...scripted.agents?.defaults,
        models: {
          [`mock-openai/${MODEL_ID}`]: {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
        // Recovery compaction must find older history to summarize in a short conversation.
        compaction: { mode: "default", memoryFlush: { enabled: false }, keepRecentTokens: 1_000 },
      },
    },
    messages: {
      ...config.messages,
      // Steering admits input after the queue debounce; zero keeps admission prompt.
      queue: { ...config.messages?.queue, debounceMsByChannel: { webchat: 0 } },
    },
  };
}

/** Observes Gateway events and resolves waits on the state they report. */
function createEventLog() {
  const events: GatewayEvent[] = [];
  const listeners = new Set<(event: GatewayEvent) => void>();
  return {
    events,
    record(event: GatewayEvent) {
      events.push(event);
      for (const listener of listeners) {
        listener(event);
      }
    },
    /** Resolves when a matching Gateway event has been received. */
    waitFor(matches: (event: GatewayEvent) => boolean) {
      return new Promise<GatewayEvent>((resolve) => {
        const found = events.find(matches);
        if (found) {
          resolve(found);
          return;
        }
        const listener = (event: GatewayEvent) => {
          if (matches(event)) {
            listeners.delete(listener);
            resolve(event);
          }
        };
        listeners.add(listener);
      });
    },
  };
}

/**
 * The scenario-facing API both fixtures share: conversations, held model turns and
 * script accounting over one Control UI operator connection.
 */
function createSteeringApi(params: {
  agentId: string;
  model: ScriptedModel;
  log: ReturnType<typeof createEventLog>;
  operator: GatewayClient;
}) {
  const { agentId, model, log, operator } = params;
  const heldTurns: Array<ReturnType<typeof heldReply>> = [];
  const sentMessages = new Set<string>();

  /** One conversation per scenario. */
  const session = () => {
    const sessionKey = `agent:${agentId}:dashboard:${randomUUID()}`;
    // A conversation's requests carry at least one message it sent, even after compaction
    // summarizes older ones, which attributes concurrent conversations without arrival order.
    const sent: string[] = [];
    const ownRequests = () =>
      model.requests.filter((request) =>
        userTexts(request).some((text) => sent.some((message) => text.includes(message))),
      );
    const agentWait = (runId: string): Promise<RunResult> =>
      operator.request("agent.wait", { runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
    return {
      sessionKey,
      /** Agent requests the model received for this conversation. */
      requests: ownRequests,
      /** Resolves when this conversation's zero-based agent request reaches the model. */
      request: (index: number) => model.whenRequest(() => ownRequests()[index]),
      send: (message: string, client: GatewayClient = operator): Promise<ChatSendResult> => {
        if (sentMessages.has(message)) {
          throw new Error(`Messages must be unique across conversations: ${message}`);
        }
        sentMessages.add(message);
        sent.push(message);
        return client.request("chat.send", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
      },
      /**
       * The run's terminal result. agent.wait answers "pending" at once while a source is
       * still queued or awaiting its steered consumption, so those wait for settlement first.
       */
      wait: async (runId: string): Promise<RunResult> => {
        const result = await agentWait(runId);
        if (result.status !== "pending") {
          return result;
        }
        // Queued runs end with their own lifecycle; steered input settles with its chat final.
        await log.waitFor(
          (event) => isTerminalLifecycle(event, runId) || isFinalChat(event, runId),
        );
        return agentWait(runId);
      },
      history: (): Promise<ChatHistory> =>
        operator.request("chat.history", { sessionKey, limit: 100 }),
      executedRuns: () => executedRunIds(log.events, sessionKey),
      /** Chat states published for `runId`, in order. */
      chatStates: (runId: string) =>
        log.events
          .filter((event) => isChat(event, runId))
          .map((event) => (event.payload as ChatEventPayload).state),
      /** Resolves with the first chat event of `runId`, such as an acknowledgement. */
      chat: (runId: string) => log.waitFor((event) => isChat(event, runId)),
      /** Resolves with the final chat event of `runId`. */
      final: (runId: string) => log.waitFor((event) => isFinalChat(event, runId)),
      /** Resolves with the run that produced a final reply of `text` in this conversation. */
      finalReply: async (text: string) => {
        const event = await log.waitFor((candidate) => {
          const payload = candidate.payload as
            | (ChatEventPayload & { sessionKey?: string })
            | undefined;
          return (
            candidate.event === "chat" &&
            payload?.sessionKey === sessionKey &&
            payload.state === "final" &&
            finalText(candidate) === text
          );
        });
        return (event.payload as ChatEventPayload).runId!;
      },
      /** Compaction progress published for `runId`. */
      compaction: (runId: string) =>
        agentEvents(log.events)
          .filter((event) => event.runId === runId && event.stream === "compaction")
          .map((event) => event.data),
    };
  };

  return {
    model,
    events: log.events,
    operator,
    session,
    /** A held reply that scenario cleanup releases even when the scenario fails. */
    held(text: string) {
      const turn = heldReply(text);
      heldTurns.push(turn);
      return turn;
    },
    /** Fails the scenario if the model saw requests it was not scripted for. */
    assertScriptConsumed() {
      for (const turn of heldTurns.splice(0)) {
        turn.release();
      }
      if (model.failures.length > 0) {
        throw new AggregateError(model.failures.splice(0), "Unscripted model requests");
      }
      const unused = model.clearTurns();
      if (unused !== 0) {
        throw new Error(`${unused} scripted model turns were never requested`);
      }
    },
  };
}
type SteeringApi = ReturnType<typeof createSteeringApi>;
export type SteeringSession = ReturnType<SteeringApi["session"]>;

/**
 * A real Gateway process for a whole suite, with one Control UI operator. Admission, the
 * session controller, the runtime and SQLite transcripts are production code; only the
 * model is scripted. Out of process, it is unaffected by per-test in-process resets.
 */
export async function startSteeringGateway() {
  const model = await startScriptedModel();
  const owner = createQaGatewayChild();
  const log = createEventLog();
  const clients: GatewayClient[] = [];
  const close = async () => {
    const errors: unknown[] = [];
    for (const step of [
      ...clients.splice(0).map((client) => () => disconnectGatewayClient(client)),
      () => stopQaGatewayFixture(owner),
      () => model.close(),
    ]) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Session steering Gateway cleanup failed");
    }
  };
  try {
    const gateway = await owner.start({
      repoRoot: process.cwd(),
      providerBaseUrl: `${model.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: `mock-openai/${MODEL_ID}`,
      alternateModel: `mock-openai/${MODEL_ID}`,
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      fastMode: true,
      useRepoCli: false,
      runtimeEnvPatch: { OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_TEST_MINIMAL_GATEWAY: "1" },
      mutateConfig: (config) => {
        const steering = applySteeringConfig(config, model);
        return {
          ...steering,
          gateway: {
            ...steering.gateway,
            controlUi: { ...steering.gateway?.controlUi, allowedOrigins: [LOOPBACK_ORIGIN] },
          },
        };
      },
    });
    const connect = async () => {
      const client = await connectGatewayClient({
        url: gateway.wsUrl,
        token: gateway.token,
        ...CONTROL_UI,
        origin: LOOPBACK_ORIGIN,
        onEvent: (event) => log.record(event),
      });
      clients.push(client);
      return client;
    };
    const operator = await connect();
    return {
      ...createSteeringApi({ agentId: "qa", model, log, operator }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
const LOOPBACK_ORIGIN = "http://127.0.0.1";
export type SteeringGateway = Awaited<ReturnType<typeof startSteeringGateway>>;

// Edge identity headers require TLS, so people mode serves wss with a test certificate.
const PEOPLE_ORIGIN = "https://control.example.test";
const TLS_FINGERPRINT = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const ALICE = "alice@example.test";
export const BOB = "bob@example.test";

/** Trusted-proxy headers that identify one signed-in person to the Gateway. */
function personHeaders(email: string) {
  return {
    "x-forwarded-for": "203.0.113.50",
    "x-forwarded-proto": "https",
    "x-forwarded-user": email,
  };
}

/**
 * Runs one scenario on an in-process Gateway where Alice and Bob sign in through a
 * trusted proxy, so the Gateway attributes each message to a distinct requester.
 * Shared-token Gateways have one owner identity, so these scenarios need their own.
 */
export async function withPeopleGateway(
  options: { allowCollaborativeSteering?: boolean },
  run: (
    gateway: SteeringApi & {
      alice: GatewayClient;
      connectAs: (email: string) => Promise<GatewayClient>;
    },
  ) => Promise<void>,
): Promise<void> {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-steering-"));
  const stateDir = path.join(home, ".openclaw");
  const workspaceDir = path.join(home, "workspace");
  const bundledPluginsDir = path.join(home, "empty-bundled-plugins");
  await Promise.all(
    [stateDir, workspaceDir, bundledPluginsDir].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
  const certPath = path.join(home, "cert.pem");
  const keyPath = path.join(home, "key.pem");
  await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
  await fs.writeFile(keyPath, TEST_TLS_KEY_PEM);
  const env = {
    ...isolatedGatewayEnv,
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    // Trusted-proxy and shared-token authentication are mutually exclusive.
    OPENCLAW_GATEWAY_TOKEN: undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_GATEWAY_URL: undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    ALL_PROXY: undefined,
    HTTP_PROXY: undefined,
    HTTPS_PROXY: undefined,
    all_proxy: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  try {
    await withEnvAsync(env, async () => {
      const model = await startScriptedModel();
      const log = createEventLog();
      const clients: GatewayClient[] = [];
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        const config = applySteeringConfig({}, model);
        config.agents!.defaults!.workspace = workspaceDir;
        config.agents!.entries = { main: {} };
        config.messages!.queue!.allowCollaborativeSteering = options.allowCollaborativeSteering;
        const gatewayConfig: NonNullable<OpenClawConfig["gateway"]> = {
          trustedProxies: ["127.0.0.1"],
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
              requiredHeaders: ["x-forwarded-proto"],
              allowLoopback: true,
              deviceAutoApprove: { enabled: true, scopes: [...OPERATOR_SCOPES] },
            },
            // Identical permissions: only the person differs.
            identityScopes: { [ALICE]: [...OPERATOR_SCOPES], [BOB]: [...OPERATOR_SCOPES] },
          },
          controlUi: { allowedOrigins: [PEOPLE_ORIGIN] },
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
        };
        config.gateway = gatewayConfig;
        gateway = await startGatewayWithClient({
          cfg: config,
          configPath: path.join(stateDir, "openclaw.json"),
          auth: gatewayConfig.auth,
          edgeAuthHeaders: personHeaders(ALICE),
          secure: true,
          tlsFingerprint: TLS_FINGERPRINT,
          origin: PEOPLE_ORIGIN,
          ...CONTROL_UI,
          onEvent: (event) => log.record(event),
        });
        await gateway.server.startupSettled;
        const port = gateway.port;
        const connectAs = async (email: string) => {
          const client = await connectGatewayClient({
            url: `wss://127.0.0.1:${port}`,
            ...CONTROL_UI,
            origin: PEOPLE_ORIGIN,
            tlsFingerprint: TLS_FINGERPRINT,
            edgeAuthHeaders: personHeaders(email),
            // A distinct device per person; the Gateway identifies people, not sockets.
            deviceFamily: email,
          });
          clients.push(client);
          return client;
        };
        const api = createSteeringApi({ agentId: "main", model, log, operator: gateway.client });
        await run({ ...api, alice: gateway.client, connectAs });
        api.assertScriptConsumed();
      } finally {
        for (const client of clients) {
          await disconnectGatewayClient(client);
        }
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "Session steering E2E complete" });
        }
        await model.close();
      }
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

function isTerminalLifecycle(event: GatewayEvent, runId: string): boolean {
  const payload = event.payload as AgentEventPayload | undefined;
  return (
    event.event === "agent" &&
    payload?.runId === runId &&
    payload.stream === "lifecycle" &&
    (payload.data?.phase === "end" || payload.data?.phase === "error")
  );
}

function isChat(event: GatewayEvent, runId: string): boolean {
  return event.event === "chat" && (event.payload as ChatEventPayload | undefined)?.runId === runId;
}

function isFinalChat(event: GatewayEvent, runId: string): boolean {
  return isChat(event, runId) && (event.payload as ChatEventPayload).state === "final";
}

/** Text of each message with `role`, in transcript order. */
export function roleTexts(history: ChatHistory, role: string): string[] {
  return history.messages.filter((message) => message.role === role).map(messageText);
}

/** How many times each of the conversation's model requests carried `text` as user input. */
export function deliveries(session: SteeringSession, text: string): number[] {
  return session
    .requests()
    .map((request) => userTexts(request).filter((input) => input.includes(text)).length);
}

/** The message text of a chat event. */
export function finalText(event: GatewayEvent): string {
  return messageText((event.payload as ChatEventPayload).message ?? {});
}
