import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getActiveGatewayRootWorkHolders } from "../process/gateway-work-admission.js";
import {
  activateTestChannelRegistry,
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient } from "./client.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type ProviderRequest = {
  model?: string;
  tools?: Array<{ name?: string }>;
  input?: Array<{ type?: string }>;
};
type ToolCall = { args: unknown; backgroundRun: unknown; runId: unknown; senderIsOwner: unknown };
type ForkProofState = {
  toolCalls: ToolCall[];
  settled: Array<Record<string, unknown>>;
  /** `api.runtime.subagent` of each loaded generation, oldest first. */
  runtimes: Array<{ runForkedTurn: (params: Record<string, unknown>) => Promise<unknown> }>;
  /** The result of a fork started by `forkproof.start`. */
  background?: Promise<MethodResult>;
  /** Set to hold the next settlement until released. */
  hold?: { started: ReturnType<typeof createDeferred>; release: Promise<void> };
};
type MethodResult =
  | { ok: true; result: { status: string; runId?: string; value?: unknown; reason?: string } }
  | { ok: false; message: string };

const FORK_PROOF_SOURCE = `module.exports = { id: "fork-proof", register(api) {
  const state = () => globalThis.forkProofState;
  // Each loaded generation records its runtime, so a test can retain a retired one.
  state().runtimes.push(api.runtime.subagent);
  api.registerTool((ctx) => ({
    name: "fork_proof_note",
    description: "Record one note about the conversation",
    parameters: { type: "object", properties: { note: { type: "string" } } },
    execute: async (_id, args) => {
      state().toolCalls.push({
        args,
        backgroundRun: ctx.backgroundRun ?? null,
        runId: ctx.runId ?? null,
        senderIsOwner: ctx.senderIsOwner ?? null,
      });
      return { content: [{ type: "text", text: "noted" }] };
    },
  }), { name: "fork_proof_note" });
  api.registerGatewayMethod("forkproof.run", async ({ params, respond }) => {
    try {
      const result = await api.runtime.subagent.runForkedTurn({
        sessionKey: params.sessionKey,
        through: params.through,
        prompt: "Record one note about this conversation.",
        tools: params.tools,
        ...(params.runId ? { runId: params.runId } : {}),
        ...(params.provider ? { provider: params.provider, model: params.model } : {}),
        onSettled: async (outcome) => {
          state().settled.push({ ...outcome, error: outcome.ok ? undefined : String(outcome.error) });
          const hold = state().hold;
          if (hold) {
            state().hold = undefined;
            hold.started.resolve();
            await hold.release;
          }
          return "settled-value";
        },
      });
      respond(true, { ok: true, result });
    } catch (error) {
      respond(true, { ok: false, message: String(error?.message ?? error) });
    }
  }, { scope: "operator.write" });
  // Starts a fork from background work that outlives the request, like a scheduler.
  api.registerGatewayMethod("forkproof.start", async ({ params, respond }) => {
    state().background = api.runtime.subagent
      .runForkedTurn({
        sessionKey: params.sessionKey,
        through: params.through,
        prompt: "Record one note about this conversation.",
        tools: ["fork_proof_note"],
        onSettled: async (outcome) => {
          state().settled.push({ ...outcome, error: outcome.ok ? undefined : String(outcome.error) });
          return "settled-value";
        },
      })
      .then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, message: String(error?.message ?? error) }),
      );
    respond(true, { started: true });
  }, { scope: "operator.write" });
} };`;

const FORK_OTHER_SOURCE = `module.exports = { id: "fork-other", register(api) {
  api.registerTool({
    name: "fork_other_note",
    description: "Another plugin's tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "other" }] }),
  });
} };`;

async function writePlugin(root: string, id: string, tools: string[], source: string) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } }),
  );
  await fs.writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      activation: { onStartup: true },
      configSchema: { type: "object" },
      contracts: { tools },
    }),
  );
  await fs.writeFile(path.join(dir, "index.cjs"), source);
  return dir;
}

function toolCallResponse(response: ServerResponse, id: string) {
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: id,
    name: "fork_proof_note",
    arguments: JSON.stringify({ note: "fork saw the turn" }),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

type Fixture = {
  client: GatewayClient;
  /** Set to hold the next fork model request until released. */
  modelHold: { current?: { started: ReturnType<typeof createDeferred>; release: Promise<void> } };
  port: number;
  token: string;
  proof: ForkProofState;
  forkRequests: ProviderRequest[];
  foregroundRequests: ProviderRequest[];
  /** A dashboard turn by the authenticated operator; returns its completed assistant entry. */
  dashboardTurn: (sessionKey: string) => Promise<Turn>;
  /** An authorized Telegram direct message through the channel inbound dispatcher. */
  channelTurn: (sessionKey: string, senderId: string) => Promise<Turn>;
  fork: (
    turn: Turn,
    params: Record<string, unknown>,
    client?: GatewayClient,
  ) => Promise<MethodResult>;
  patchConfig: (patch: Record<string, unknown>) => Promise<void>;
};
type Turn = {
  sessionKey: string;
  sessionId: string;
  entryId: string;
  scope: { agentId: string; sessionKey: string; storePath: string };
};

async function withForkGateway(
  configure: (config: OpenClawConfig) => OpenClawConfig,
  run: (fixture: Fixture) => Promise<void>,
) {
  const state = await createOpenClawTestState({
    layout: "home",
    prefix: "openclaw-plugin-forked-turn-",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  const proof: ForkProofState = { toolCalls: [], settled: [], runtimes: [] };
  (globalThis as { forkProofState?: ForkProofState }).forkProofState = proof;
  const forkRequests: ProviderRequest[] = [];
  const foregroundRequests: ProviderRequest[] = [];
  let mode: "foreground" | "fork" = "foreground";
  let serial = 0;
  const modelHold: Fixture["modelHold"] = {};
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  try {
    const pluginRoot = state.path("plugins");
    const forkProofDir = await writePlugin(
      pluginRoot,
      "fork-proof",
      ["fork_proof_note"],
      FORK_PROOF_SOURCE,
    );
    const forkOtherDir = await writePlugin(
      pluginRoot,
      "fork-other",
      ["fork_other_note"],
      FORK_OTHER_SOURCE,
    );
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await withServer(
      (request, response) => {
        void (async () => {
          if (request.url !== "/v1/responses" || request.method !== "POST") {
            response.writeHead(404).end();
            return;
          }
          const payload = JSON.parse(await readText(request)) as ProviderRequest;
          serial += 1;
          if (mode === "fork") {
            forkRequests.push(payload);
            const hold = modelHold.current;
            if (hold) {
              modelHold.current = undefined;
              hold.started.resolve();
              await hold.release;
            }
            // Each fork calls its tool once, then answers.
            if (!payload.input?.some((item) => item.type === "function_call_output")) {
              toolCallResponse(response, `fork_${serial}`);
              return;
            }
          } else {
            foregroundRequests.push(payload);
          }
          writeOpenAiResponsesText(response, {
            text: mode === "fork" ? "FORK_DONE" : "FOREGROUND_DONE",
            messageId: `msg_${serial}`,
            responseId: `resp_${serial}`,
          });
        })().catch((error: unknown) => {
          response.writeHead(500).end(String(error));
        });
      },
      async (baseUrl) => {
        const provider = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, "fork-proof");
        const token = "isolated-plugin-fork-token";
        const config = configure({
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          plugins: {
            allow: ["fork-proof", "fork-other"],
            load: { paths: [forkProofDir, forkOtherDir] },
            slots: { memory: "none" },
            entries: {
              "fork-proof": { hooks: { allowConversationAccess: true } },
              "fork-other": {},
            },
          },
          tools: { profile: "coding" },
          skills: { load: { watch: false } },
        });
        const active = await startGatewayWithClient({
          cfg: config,
          configPath: state.configPath,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        gateway = active;
        await activateTestChannelRegistry(
          createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: {
                ...createChannelTestPluginBase({ id: "telegram" }),
                outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
              },
            },
          ]),
        );
        const { client } = active;
        const anchorTurn = (sessionKey: string): Turn => {
          const scope = {
            agentId: "main",
            sessionKey,
            storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          };
          const sessionId = loadSessionEntry(scope)?.sessionId;
          if (!sessionId) {
            throw new Error("The foreground turn did not create a session");
          }
          const entryId = (
            loadTranscriptEventsSync({ ...scope, sessionId }).findLast(
              (event) =>
                (event as { type?: string }).type === "message" &&
                (event as { message?: { role?: string } }).message?.role === "assistant",
            ) as { id?: string } | undefined
          )?.id;
          if (!entryId) {
            throw new Error("The foreground turn left no assistant entry");
          }
          return { sessionKey, sessionId, entryId, scope };
        };
        await run({
          client,
          modelHold,
          port: active.port,
          token,
          proof,
          forkRequests,
          foregroundRequests,
          dashboardTurn: async (sessionKey) => {
            mode = "foreground";
            const accepted = await client.request<{ runId: string }>("agent", {
              sessionKey,
              message: "Say hello.",
              deliver: false,
              idempotencyKey: randomUUID(),
            });
            expect(
              await client.request(
                "agent.wait",
                { runId: accepted.runId, timeoutMs: 45_000 },
                { timeoutMs: 50_000 },
              ),
            ).toMatchObject({ status: "ok" });
            mode = "fork";
            return anchorTurn(sessionKey);
          },
          channelTurn: async (sessionKey, senderId) => {
            mode = "foreground";
            await dispatchInboundMessage({
              ctx: {
                Body: "Say hello.",
                RawBody: "Say hello.",
                From: `telegram:${senderId}`,
                To: `telegram:${senderId}`,
                ChatType: "direct",
                Provider: "telegram",
                Surface: "telegram",
                AccountId: "default",
                SenderId: senderId,
                SessionKey: sessionKey,
                InboundAccessAuthorized: true,
              },
              cfg: getRuntimeConfig(),
              dispatcher: createReplyDispatcher({ deliver: async () => {} }),
            });
            mode = "fork";
            return anchorTurn(sessionKey);
          },
          fork: (turn, params, caller = client) =>
            caller.request<MethodResult>(
              "forkproof.run",
              {
                sessionKey: turn.sessionKey,
                through: { sessionId: turn.sessionId, entryId: turn.entryId },
                tools: ["fork_proof_note"],
                ...params,
              },
              { timeoutMs: 120_000 },
            ),
          patchConfig: async (patch) => {
            const current = await client.request<{ hash: string }>("config.get", {});
            await client.request("config.patch", {
              baseHash: current.hash,
              raw: JSON.stringify(patch),
            });
          },
        });
      },
    );
  } finally {
    modelHold.current?.started.resolve();
    const hold = proof.hold;
    proof.hold = undefined;
    hold?.started.resolve();
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "Plugin forked turn cleanup" });
    }
    delete (globalThis as { forkProofState?: ForkProofState }).forkProofState;
    await state.cleanup();
  }
}

describe("plugin forked turns through the real Gateway", () => {
  it(
    "runs a hidden fork with only the plugin's own tool, settles inside admission, and refuses replaced sessions",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => config,
        async (fixture) => {
          const { proof, forkRequests } = fixture;
          const turn = await fixture.dashboardTurn(
            `agent:main:dashboard:direct:fork-proof-${randomUUID()}`,
          );
          const { sessionKey, sessionId, entryId, scope } = turn;
          const transcript = () => loadTranscriptEventsSync({ ...scope, sessionId });

          // Trust rule: only tools this plugin itself registered.
          await expect(fixture.fork(turn, { tools: ["exec"] })).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining('may not add core tool "exec"'),
          });
          await expect(fixture.fork(turn, { tools: ["fork_other_note"] })).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining(
              'does not uniquely own subagent tool "fork_other_note"',
            ),
          });
          await expect(
            fixture.fork(turn, { through: { sessionId: "stale", entryId } }),
          ).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("was reset or replaced"),
          });
          await expect(
            fixture.fork(turn, { through: { sessionId, entryId: "missing" } }),
          ).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining('has no active entry "missing"'),
          });
          expect(forkRequests).toEqual([]);

          const before = JSON.stringify(transcript());
          const runId = `fork-proof-${randomUUID()}`;
          const release = createDeferred();
          const started = createDeferred();
          proof.hold = { started, release: release.promise };
          const pending = fixture.fork(turn, { runId });
          await started.promise;
          // Settlement holds the fork's detached admission; a graceful restart waits for it.
          expect(getActiveGatewayRootWorkHolders()).toContain("plugin:fork-proof:session-fork");
          release.resolve();
          await expect(pending).resolves.toEqual({
            ok: true,
            result: { status: "settled", runId, value: "settled-value" },
          });
          expect(getActiveGatewayRootWorkHolders()).not.toContain("plugin:fork-proof:session-fork");
          expect(proof.settled).toEqual([
            {
              ok: true,
              runId,
              text: "FORK_DONE",
              source: { sessionId, lifecycleRevision: expect.anything() },
              error: undefined,
            },
          ]);
          expect(proof.toolCalls).toEqual([
            {
              args: { note: "fork saw the turn" },
              backgroundRun: { sourceSessionKey: sessionKey, ownerPluginId: "fork-proof" },
              runId,
              // The authenticated operator's turn keeps its owner authority in the fork.
              senderIsOwner: true,
            },
          ]);
          // The fork sees only the caller's tool, never core or other plugins' tools.
          expect(forkRequests[0]?.tools?.map((tool) => tool.name)).toEqual(["fork_proof_note"]);
          // The fork runs on the model the anchored turn ran on.
          expect(forkRequests[0]?.model).toBe(fixture.foregroundRequests[0]?.model);
          // A hidden fork never writes the source transcript.
          expect(JSON.stringify(transcript())).toBe(before);

          // A Gateway reset keeps the session id and rotates its lifecycle revision. The fork
          // still reads through the completed entry, and reports the generation it read so
          // follow-up writes can skip the newer generation.
          const firstGeneration = proof.settled[0]?.source as { lifecycleRevision?: unknown };
          await fixture.client.request("sessions.reset", { key: sessionKey });
          const resetEntry = loadSessionEntry(scope);
          expect(resetEntry?.sessionId).toBe(sessionId);
          await expect(fixture.fork(turn, {})).resolves.toMatchObject({
            ok: true,
            result: { status: "settled" },
          });
          expect(proof.settled[1]?.source).toEqual({
            sessionId,
            lifecycleRevision: resetEntry?.lifecycleRevision,
          });
          expect(resetEntry?.lifecycleRevision).not.toBe(firstGeneration.lifecycleRevision);

          // The session's own deny policy still applies to the plugin's tool.
          const forkCalls = forkRequests.length;
          await fixture.patchConfig({ tools: { deny: ["fork_proof_note"] } });
          await expect
            .poll(async () => fixture.fork(turn, {}), { timeout: 30_000, interval: 500 })
            .toEqual({ ok: true, result: { status: "refused", reason: "tool_policy" } });
          expect(forkRequests).toHaveLength(forkCalls);
        },
      );
    },
  );

  it(
    "checks policy as the anchored turn's sender and keeps the turn's model",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => ({
          ...config,
          // Sender 42 may not use the plugin's tool; the stored session never records senders.
          tools: { ...config.tools, toolsBySender: { "id:42": { deny: ["fork_proof_note"] } } },
        }),
        async (fixture) => {
          const blocked = await fixture.channelTurn(
            `agent:main:telegram:direct:fork-proof-42-${randomUUID()}`,
            "42",
          );
          const allowed = await fixture.channelTurn(
            `agent:main:telegram:direct:fork-proof-7-${randomUUID()}`,
            "7",
          );
          await expect(fixture.fork(blocked, {})).resolves.toEqual({
            ok: true,
            result: { status: "refused", reason: "tool_policy" },
          });
          expect(fixture.forkRequests).toEqual([]);
          await expect(fixture.fork(allowed, {})).resolves.toMatchObject({
            ok: true,
            result: { status: "settled" },
          });
          // A channel sender's turn does not gain owner authority in the fork.
          expect(fixture.proof.toolCalls).toEqual([
            expect.objectContaining({ senderIsOwner: false }),
          ]);
          // The fork runs on the model the anchored turn ran on.
          expect(fixture.forkRequests[0]?.model).toBe(fixture.foregroundRequests.at(-1)?.model);

          // Overrides need trust unless they name the turn's own model.
          const writer = await connectGatewayClient({
            url: `ws://127.0.0.1:${fixture.port}`,
            token: fixture.token,
            scopes: ["operator.write"],
          });
          try {
            await expect(
              fixture.fork(allowed, { provider: "mock-openai", model: "other-model" }, writer),
            ).resolves.toMatchObject({
              ok: false,
              message: expect.stringContaining("override is not authorized"),
            });
            await expect(
              fixture.fork(allowed, { provider: "mock-openai", model: "fork-proof" }, writer),
            ).resolves.toMatchObject({ ok: true, result: { status: "settled" } });
          } finally {
            await disconnectGatewayClient(writer);
          }
        },
      );
    },
  );

  it(
    "drains an in-flight fork through settlement on reload and refuses the retired runtime",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => config,
        async (fixture) => {
          const turn = await fixture.dashboardTurn(
            `agent:main:dashboard:direct:fork-proof-reload-${randomUUID()}`,
          );
          const through = { sessionId: turn.sessionId, entryId: turn.entryId };
          const started = createDeferred();
          const release = createDeferred();
          fixture.modelHold.current = { started, release: release.promise };
          await fixture.client.request("forkproof.start", { sessionKey: turn.sessionKey, through });
          await started.promise;
          const pending = fixture.proof.background;
          const forkProofRecord = () =>
            getActivePluginRegistry()?.plugins.find((plugin) => plugin.id === "fork-proof");
          const original = forkProofRecord();
          const retired = fixture.proof.runtimes[0];
          // The real reload path waits for this registration's in-flight fork.
          let reloaded = false;
          const reload = fixture.client
            .request(
              "plugins.reload",
              { plugins: [{ pluginId: "fork-proof" }] },
              { timeoutMs: 60_000 },
            )
            .then(() => {
              reloaded = true;
            });
          await new Promise((resolve) => {
            setTimeout(resolve, 1_500);
          });
          expect(reloaded).toBe(false);
          expect(forkProofRecord()).toBe(original);
          release.resolve();
          // The draining registration stays the live owner: its tool and settlement both run.
          await expect(pending).resolves.toMatchObject({
            ok: true,
            result: { status: "settled", value: "settled-value" },
          });
          expect(fixture.proof.toolCalls).toHaveLength(1);
          expect(fixture.proof.settled).toEqual([expect.objectContaining({ ok: true })]);
          await reload;
          expect(forkProofRecord()).not.toBe(original);

          // A retained runtime of the retired registration is refused before any fork work.
          await expect(
            retired?.runForkedTurn({
              sessionKey: turn.sessionKey,
              through,
              prompt: "Record one note about this conversation.",
              tools: ["fork_proof_note"],
              onSettled: () => "never",
            }),
          ).rejects.toThrow('Plugin "fork-proof" runtime is no longer active');
          expect(fixture.proof.toolCalls).toHaveLength(1);
          expect(fixture.proof.settled).toHaveLength(1);
        },
      );
    },
  );
});
