import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { getActiveGatewayRootWorkHolders } from "../process/gateway-work-admission.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type ProviderRequest = { tools?: Array<{ name?: string }> };
type ForkProofState = {
  toolCalls: Array<{ args: unknown; backgroundRun: unknown; runId: unknown }>;
  settled: Array<Record<string, unknown>>;
  settleStarted: ReturnType<typeof createDeferred>;
  release: Promise<void>;
};
type MethodResult =
  | { ok: true; result: { status: string; runId?: string; value?: unknown; reason?: string } }
  | { ok: false; message: string };

const FORK_PROOF_SOURCE = `module.exports = { id: "fork-proof", register(api) {
  const state = () => globalThis.forkProofState;
  api.registerTool((ctx) => ({
    name: "fork_proof_note",
    description: "Record one note about the conversation",
    parameters: { type: "object", properties: { note: { type: "string" } } },
    execute: async (_id, args) => {
      state().toolCalls.push({ args, backgroundRun: ctx.backgroundRun ?? null, runId: ctx.runId ?? null });
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
        onSettled: async (outcome) => {
          state().settled.push({ ...outcome, error: outcome.ok ? undefined : String(outcome.error) });
          state().settleStarted.resolve();
          await state().release;
          return "settled-value";
        },
      });
      respond(true, { ok: true, result });
    } catch (error) {
      respond(true, { ok: false, message: String(error?.message ?? error) });
    }
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

function toolCallResponse(response: import("node:http").ServerResponse, id: string) {
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

describe("plugin forked turns through the real Gateway", () => {
  it(
    "runs a hidden fork with only the plugin's own tool, settles inside admission, and refuses replaced sessions",
    { timeout: 150_000 },
    async () => {
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
      const release = createDeferred();
      const proof: ForkProofState = {
        toolCalls: [],
        settled: [],
        settleStarted: createDeferred(),
        release: release.promise,
      };
      (globalThis as { forkProofState?: ForkProofState }).forkProofState = proof;
      const forkRequests: ProviderRequest[] = [];
      let mode: "foreground" | "fork" = "foreground";
      let serial = 0;
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
                if (forkRequests.length === 1) {
                  toolCallResponse(response, `fork_${serial}`);
                  return;
                }
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
            const config = {
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
            } satisfies OpenClawConfig;
            gateway = await startGatewayWithClient({
              cfg: config,
              configPath: state.configPath,
              token,
              scopes: ["operator.admin", "operator.read", "operator.write"],
            });
            const { client } = gateway;
            const sessionKey = `agent:main:dashboard:direct:fork-proof-${randomUUID()}`;
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
            const scope = {
              agentId: "main",
              sessionKey,
              storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            };
            const sessionId = loadSessionEntry(scope)?.sessionId;
            if (!sessionId) {
              throw new Error("The foreground turn did not create a session");
            }
            const transcript = () => loadTranscriptEventsSync({ ...scope, sessionId });
            const entryId = (
              transcript().findLast(
                (event) =>
                  (event as { type?: string; message?: { role?: string } }).type === "message" &&
                  (event as { message?: { role?: string } }).message?.role === "assistant",
              ) as { id?: string } | undefined
            )?.id;
            if (!entryId) {
              throw new Error("The foreground turn left no assistant entry");
            }
            const run = (params: Record<string, unknown>) =>
              client.request<MethodResult>(
                "forkproof.run",
                { sessionKey, through: { sessionId, entryId }, ...params },
                { timeoutMs: 120_000 },
              );

            // Trust rule: only tools this plugin itself registered.
            await expect(run({ tools: ["exec"] })).resolves.toMatchObject({
              ok: false,
              message: expect.stringContaining('may not add core tool "exec"'),
            });
            await expect(run({ tools: ["fork_other_note"] })).resolves.toMatchObject({
              ok: false,
              message: expect.stringContaining(
                'does not uniquely own subagent tool "fork_other_note"',
              ),
            });
            await expect(
              run({ tools: ["fork_proof_note"], through: { sessionId: "stale", entryId } }),
            ).resolves.toMatchObject({
              ok: false,
              message: expect.stringContaining("was reset or replaced"),
            });
            await expect(
              run({ tools: ["fork_proof_note"], through: { sessionId, entryId: "missing" } }),
            ).resolves.toMatchObject({
              ok: false,
              message: expect.stringContaining('has no active entry "missing"'),
            });
            expect(forkRequests).toEqual([]);

            const before = JSON.stringify(transcript());
            mode = "fork";
            const runId = `fork-proof-${randomUUID()}`;
            const pending = run({ tools: ["fork_proof_note"], runId });
            await proof.settleStarted.promise;
            // Settlement holds the fork's detached admission; a graceful restart waits for it.
            expect(getActiveGatewayRootWorkHolders()).toContain("plugin:fork-proof:session-fork");
            release.resolve();
            await expect(pending).resolves.toEqual({
              ok: true,
              result: { status: "settled", runId, value: "settled-value" },
            });
            expect(getActiveGatewayRootWorkHolders()).not.toContain(
              "plugin:fork-proof:session-fork",
            );
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
              },
            ]);
            // The fork sees only the caller's tool, never core or other plugins' tools.
            expect(forkRequests[0]?.tools?.map((tool) => tool.name)).toEqual(["fork_proof_note"]);
            // A hidden fork never writes the source transcript.
            expect(JSON.stringify(transcript())).toBe(before);

            // A Gateway reset keeps the session id and rotates its lifecycle revision. The fork
            // still reads through the completed entry, and reports the generation it read so
            // follow-up writes can skip the newer generation.
            const firstGeneration = proof.settled[0]?.source as { lifecycleRevision?: unknown };
            await client.request("sessions.reset", { key: sessionKey });
            const resetEntry = loadSessionEntry(scope);
            expect(resetEntry?.sessionId).toBe(sessionId);
            await expect(run({ tools: ["fork_proof_note"] })).resolves.toMatchObject({
              ok: true,
              result: { status: "settled" },
            });
            expect(proof.settled[1]?.source).toEqual({
              sessionId,
              lifecycleRevision: resetEntry?.lifecycleRevision,
            });
            expect(resetEntry?.lifecycleRevision).not.toBe(firstGeneration.lifecycleRevision);

            // The session's own deny policy still applies to the plugin's tool.
            const current = await client.request<{ hash: string }>("config.get", {});
            await client.request("config.patch", {
              baseHash: current.hash,
              raw: JSON.stringify({ tools: { deny: ["fork_proof_note"] } }),
            });
            await expect
              .poll(async () => run({ tools: ["fork_proof_note"] }), {
                timeout: 30_000,
                interval: 500,
              })
              .toEqual({ ok: true, result: { status: "refused", reason: "tool_policy" } });

            // Two model calls for the first fork, one for the post-reset fork, none after the deny.
            expect(forkRequests).toHaveLength(3);
          },
        );
      } finally {
        release.resolve();
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "Plugin forked turn cleanup" });
        }
        delete (globalThis as { forkProofState?: ForkProofState }).forkProofState;
        await state.cleanup();
      }
    },
  );
});
