import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
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
          await runQaGatewayFixture(
            async () => {
              await fixture.start();

              // Gateway chat commits the typed input before commands run, so the record keeps
              // the command and the replacement is its model projection (core /learn's shape here).
              const plain = "agent:main:recall-plain";
              await sendChatAndWait(fixture.client, plain, "/recall alpha");
              expect(recallRequests()).toHaveLength(1);
              expect(recallRequests()[0]).toContain("RECALL_PROMPT alpha subagents=false");
              expect(recallRequests()[0]).not.toContain("/recall alpha");
              const plainRows = userRows(plain);
              expect(plainRows.map(rowText)).toEqual(["/recall alpha"]);
              expect(readModelPromptProjection(plainRows[0]!)).toBe(
                "RECALL_PROMPT alpha subagents=false",
              );

              // A subagent-capable command commits its input before exposing subagents; the
              // continuation keeps that record and the model still receives the replacement.
              const panel = "agent:main:recall-panel";
              await sendChatAndWait(fixture.client, panel, "/recall-panel beta");
              const panelRequests = recallRequests().filter((body) => body.includes("beta"));
              expect(panelRequests).toHaveLength(1);
              expect(panelRequests[0]).toContain("RECALL_PROMPT beta subagents=true");
              expect(panelRequests[0]).not.toContain("/recall-panel beta");
              const panelRows = userRows(panel);
              expect(panelRows.map(rowText)).toEqual(["/recall-panel beta"]);
              expect(readModelPromptProjection(panelRows[0]!)).toBe(
                "RECALL_PROMPT beta subagents=true",
              );

              // Native surfaces (Telegram, Discord) run the command, then hand the dispatch over.
              const cfg = getRuntimeConfig();
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
                const delivered: ReplyPayload[] = [];
                await dispatchInboundMessageWithDispatcher({
                  ctx: {
                    Body: params.body,
                    RawBody: params.body,
                    BodyForAgent: params.body,
                    CommandBody: params.body,
                    CommandSource: "native",
                    CommandAuthorized: params.turnAuthorized,
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
                  replyOptions: { [PLUGIN_COMMAND_DISPATCH]: dispatch },
                });
                return { executed, delivered };
              };

              const allowed = await native({
                body: "/recall gamma",
                sessionKey: "agent:main:native-allowed",
                executeAuthorized: true,
                turnAuthorized: true,
              });
              expect(allowed.executed.continueAgent).toEqual({
                prompt: "RECALL_PROMPT gamma subagents=false",
              });
              await expect
                .poll(() => recallRequests().filter((body) => body.includes("gamma")).length)
                .toBe(1);

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
              const gate = createDeferredCore<void>();
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
