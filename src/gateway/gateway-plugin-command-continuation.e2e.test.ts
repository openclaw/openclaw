import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { dispatchInboundMessageWithDispatcher } from "../auto-reply/dispatch.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import {
  createPluginCommandRuntime,
  matchPluginCommandInvocation,
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandDispatch,
} from "../plugins/plugin-command-runtime.js";
import { readModelPromptProjection } from "../sessions/user-turn-transcript.message.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatFixture, sendChatAndWait } from "./gateway-chat-fixture.test-support.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

const PLUGIN_ID = "recall-commands";
// The bridge lets the test hold a handler open; everything else is a real plugin on disk.
const PLUGIN_SOURCE = `module.exports = { id: "${PLUGIN_ID}", register(api) {
  const handler = async (ctx) => {
    globalThis.openclawRecallRuns = (globalThis.openclawRecallRuns ?? 0) + 1;
    await globalThis.openclawRecallGate?.promise;
    const subagents = ctx.runtimeContext?.subagents !== undefined;
    return { continueAgent: { prompt: "RECALL_PROMPT " + (ctx.args ?? "") + " subagents=" + subagents } };
  };
  api.registerCommand({ name: "recall", description: "Recall", acceptsArgs: true, handler });
  api.registerCommand({
    name: "recall-panel",
    description: "Recall with a review panel",
    acceptsArgs: true,
    requireAuth: true,
    runtimeCapabilities: ["subagents"],
    handler,
  });
} };`;

declare global {
  var openclawRecallRuns: number | undefined;
  var openclawRecallGate: { promise: Promise<void> } | undefined;
}

function userRows(sessionKey: string) {
  const scope = {
    agentId: "main",
    sessionKey,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  const entry = loadSessionEntry(scope);
  return entry
    ? loadTranscriptEventsSync({ ...scope, sessionId: entry.sessionId }).flatMap((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message?.role === "user" ? [message] : [];
      })
    : [];
}

function rowText(row: Record<string, unknown>) {
  const content = row.content;
  if (typeof content === "string") {
    return content;
  }
  const block = Array.isArray(content)
    ? content.map(asOptionalRecord).find((entry) => entry?.type === "text")
    : undefined;
  return block?.text;
}

it(
  "continues plugin commands into the agent turn, keeps committed input, and re-authorizes native continuations",
  { timeout: 150_000 },
  async () => {
    const pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recall-plugin-"));
    const pluginFile = path.join(pluginDir, "index.cjs");
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: PLUGIN_ID,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: { commandRuntimeCapabilities: ["subagents"] },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: PLUGIN_ID,
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    await fs.writeFile(pluginFile, PLUGIN_SOURCE);
    try {
      await withOpenClawTestState(
        {
          label: "plugin-command-continuation",
          env: {
            ...KERNEL_TEST_ENV,
            VITEST: process.env.VITEST,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        },
        async () => {
          const fixture = createChatFixture("plugin-command-continuation", {
            configure: (config) => ({
              ...config,
              agents: { ...config.agents, ownership: "explicit", entries: { main: {} } },
              commands: { text: true },
              tools: { profile: "coding", toolSearch: false },
              plugins: {
                slots: { memory: "none" },
                allow: [PLUGIN_ID],
                load: { paths: [pluginDir] },
                entries: { [PLUGIN_ID]: { enabled: true } },
              },
            }),
            respond: async (body) =>
              body.includes("conversationLabelSource") ? "Recall test" : "Fixture reply complete.",
          });
          // The provider request list is the model-call boundary for every case below.
          const recallRequests = () =>
            fixture.requests.filter((body) => body.includes("RECALL_PROMPT"));
          // One foreground provider request per turn; title generation is a separate request.
          const captureTurn = async (send: () => Promise<unknown>) => {
            const before = fixture.requests.length;
            await send();
            const turn = fixture.requests
              .slice(before)
              .filter((body) => !body.includes("conversationLabelSource"));
            expect(turn).toHaveLength(1);
            return snapshotProviderPrefix("openai-responses", JSON.parse(turn[0]!));
          };
          // Turn N+1 and N+2 must replay every byte turn N sent, then only append.
          const assertRewrittenTurnReplays = async (params: {
            label: string;
            turnN: ReturnType<typeof snapshotProviderPrefix>;
            prompt: string;
            send: (message: string) => Promise<unknown>;
          }) => {
            const next = await captureTurn(() => params.send(`FOLLOW_UP_ONE ${params.label}`));
            const replay = await captureTurn(() => params.send(`FOLLOW_UP_TWO ${params.label}`));
            // Every turn ends with its own runtime-context carrier, which later turns do not
            // replay (existing contract for all turns); everything before it is the turn's prefix.
            const prefixLength = (turn: ReturnType<typeof snapshotProviderPrefix>) => {
              expect(turn.history.at(-1)).toContain("OpenClaw runtime context:");
              return turn.history.length - 1;
            };
            assertStableProviderPrefix(params.turnN, next, {
              label: `${params.label} N+1`,
              historyLength: prefixLength(params.turnN),
            });
            assertStableProviderPrefix(next, replay, {
              label: `${params.label} N+2`,
              historyLength: prefixLength(next),
            });
            assertStableProviderPrefix(params.turnN, replay, {
              label: `${params.label} N+2 against N`,
              historyLength: prefixLength(params.turnN),
            });
            // The replayed user item is the rewritten prompt, not the typed command.
            const replayedUser = next.history.find((item) => item.includes(params.prompt));
            expect(replayedUser).toBeDefined();
            expect(replayedUser).not.toContain("/recall");
          };
          await runQaGatewayFixture(
            async () => {
              await fixture.start();

              // Gateway chat commits the typed input before commands run, so the record keeps
              // the command and the replacement is its model projection (core /learn's shape here).
              const plain = "agent:main:recall-plain";
              const plainTurn = await captureTurn(() =>
                sendChatAndWait(fixture.client, plain, "/recall alpha"),
              );
              expect(recallRequests()).toHaveLength(1);
              expect(recallRequests()[0]).toContain("RECALL_PROMPT alpha subagents=false");
              expect(recallRequests()[0]).not.toContain("/recall alpha");
              const plainRows = userRows(plain);
              expect(plainRows.map(rowText)).toEqual(["/recall alpha"]);
              expect(readModelPromptProjection(plainRows[0]!)).toBe(
                "RECALL_PROMPT alpha subagents=false",
              );
              await assertRewrittenTurnReplays({
                label: "commit-first",
                turnN: plainTurn,
                prompt: "RECALL_PROMPT alpha subagents=false",
                send: (message) => sendChatAndWait(fixture.client, plain, message),
              });

              // A subagent-capable command commits its input before exposing subagents; the
              // continuation keeps that record and the model still receives the replacement.
              const panel = "agent:main:recall-panel";
              const panelTurn = await captureTurn(() =>
                sendChatAndWait(fixture.client, panel, "/recall-panel beta"),
              );
              const panelRequests = recallRequests().filter((body) => body.includes("beta"));
              expect(panelRequests).toHaveLength(1);
              expect(panelRequests[0]).toContain("RECALL_PROMPT beta subagents=true");
              expect(panelRequests[0]).not.toContain("/recall-panel beta");
              const panelRows = userRows(panel);
              expect(panelRows.map(rowText)).toEqual(["/recall-panel beta"]);
              expect(readModelPromptProjection(panelRows[0]!)).toBe(
                "RECALL_PROMPT beta subagents=true",
              );
              await assertRewrittenTurnReplays({
                label: "subagent commit-first",
                turnN: panelTurn,
                prompt: "RECALL_PROMPT beta subagents=true",
                send: (message) => sendChatAndWait(fixture.client, panel, message),
              });

              // Native surfaces (Telegram, Discord) run the command, then hand the dispatch over.
              const cfg = getRuntimeConfig();
              // The same channel ingress a native surface uses for every inbound turn.
              const channelTurn = async (params: {
                body: string;
                sessionKey: string;
                authorized: boolean;
                dispatch?: PluginCommandDispatch;
              }) => {
                const delivered: ReplyPayload[] = [];
                await dispatchInboundMessageWithDispatcher({
                  ctx: {
                    Body: params.body,
                    RawBody: params.body,
                    BodyForAgent: params.body,
                    CommandBody: params.body,
                    ...(params.dispatch ? { CommandSource: "native" as const } : {}),
                    CommandAuthorized: params.authorized,
                    Provider: "webchat",
                    Surface: "webchat",
                    ChatType: "direct",
                    SenderId: "native-requester",
                    SessionKey: params.sessionKey,
                  },
                  cfg,
                  dispatcherOptions: {
                    deliver: async (payload) => {
                      delivered.push(payload);
                    },
                  },
                  ...(params.dispatch
                    ? { replyOptions: { [PLUGIN_COMMAND_DISPATCH]: params.dispatch } }
                    : {}),
                });
                return delivered;
              };
              const native = async (params: {
                body: string;
                sessionKey: string;
                executeAuthorized: boolean;
                turnAuthorized: boolean;
              }) => {
                const dispatch = expectDefined(
                  matchPluginCommandInvocation(createPluginCommandRuntime(), params.body, {
                    channel: "webchat",
                  })?.dispatch,
                  "selected plugin command",
                );
                const executed = await dispatch.execute({
                  channel: "webchat",
                  senderId: "native-requester",
                  isAuthorizedSender: params.executeAuthorized,
                  commandBody: params.body,
                  config: cfg,
                });
                const delivered = await channelTurn({
                  body: params.body,
                  sessionKey: params.sessionKey,
                  authorized: params.turnAuthorized,
                  dispatch,
                });
                return { executed, delivered };
              };

              const nativeSession = "agent:main:native-allowed";
              let allowed: Awaited<ReturnType<typeof native>> | undefined;
              const nativeTurn = await captureTurn(async () => {
                allowed = await native({
                  body: "/recall gamma",
                  sessionKey: nativeSession,
                  executeAuthorized: true,
                  turnAuthorized: true,
                });
              });
              expect(expectDefined(allowed, "native run").executed.continueAgent).toEqual({
                prompt: "RECALL_PROMPT gamma subagents=false",
              });
              await expect
                .poll(() => recallRequests().filter((body) => body.includes("gamma")).length)
                .toBe(1);

              // Channel ingress commits nothing before commands, so the record is the prompt itself
              // (the core /learn shape on channels).
              expect(userRows(nativeSession).map(rowText)).toEqual([
                "RECALL_PROMPT gamma subagents=false",
              ]);
              // The recorder still freezes the model text, which here equals the record itself.
              expect(readModelPromptProjection(userRows(nativeSession)[0]!)).toBe(
                "RECALL_PROMPT gamma subagents=false",
              );
              await assertRewrittenTurnReplays({
                label: "normal",
                turnN: nativeTurn,
                prompt: "RECALL_PROMPT gamma subagents=false",
                send: (message) =>
                  channelTurn({ body: message, sessionKey: nativeSession, authorized: true }),
              });

              // Three handler runs so far: alpha, beta and gamma; the handoff did not rerun gamma.
              expect(globalThis.openclawRecallRuns).toBe(3);
              const runsBefore = globalThis.openclawRecallRuns;
              const requestsBefore = fixture.requests.length;
              const unauthorized = await native({
                body: "/recall delta",
                sessionKey: "agent:main:native-unauthorized",
                executeAuthorized: false,
                turnAuthorized: false,
              });
              expect(unauthorized.executed).toEqual({
                text: "⚠️ This command requires authorization.",
              });
              expect(unauthorized.delivered).toEqual([
                expect.objectContaining({ text: "⚠️ This command requires authorization." }),
              ]);
              expect(globalThis.openclawRecallRuns).toBe(runsBefore);
              expect(fixture.requests).toHaveLength(requestsBefore);

              // The handler stays open until the test releases it, then the requester loses
              // access before the continued turn reaches the reply pipeline.
              const gate = createDeferredCore();
              globalThis.openclawRecallGate = gate;
              const released = (async () => {
                await expect.poll(() => globalThis.openclawRecallRuns).toBe((runsBefore ?? 0) + 1);
                gate.resolve();
              })();
              const revoked = await native({
                body: "/recall epsilon",
                sessionKey: "agent:main:native-revoked",
                executeAuthorized: true,
                turnAuthorized: false,
              }).finally(() => {
                globalThis.openclawRecallGate = undefined;
              });
              await released;
              expect(revoked.executed.continueAgent).toEqual({
                prompt: "RECALL_PROMPT epsilon subagents=false",
              });
              expect(revoked.delivered).toEqual([
                expect.objectContaining({ text: "⚠️ This command requires authorization." }),
              ]);
              expect(fixture.requests).toHaveLength(requestsBefore);
              expect(fixture.errors).toEqual([]);
            },
            async () => {
              await fixture.close();
            },
          );
        },
      );
    } finally {
      globalThis.openclawRecallRuns = undefined;
      globalThis.openclawRecallGate = undefined;
      await fs.rm(pluginDir, { recursive: true, force: true });
    }
  },
);
