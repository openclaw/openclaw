import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MockOpenAiRequestSnapshot } from "../../../../extensions/qa-lab/api.js";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const CHANNEL_ID = "ask-user-adoption-proof";
const MODEL = "mock-openai/gpt-5.6-luna";
const MODEL_ALT = "mock-openai/gpt-5.6-luna-alt";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const gatewayOwners: Array<ReturnType<typeof createQaLiveLaneGateway>> = [];

afterEach(async () => {
  for (const owner of gatewayOwners.splice(0).toReversed()) {
    await stopQaGatewayFixture(owner);
  }
});

type TraceEntry = {
  event: string;
  id?: string;
  kind?: string;
  text?: string;
};

async function writeProofPlugin(params: {
  pluginDir: string;
  inboxPath: string;
  tracePath: string;
}) {
  await fs.mkdir(params.pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: CHANNEL_ID,
        activation: { onStartup: true },
        channels: [CHANNEL_ID],
        channelConfigs: {
          [CHANNEL_ID]: {
            label: "Ask User Adoption Proof",
            description: "Synthetic ask_user channel-adoption proof.",
          },
        },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(params.pluginDir, "index.cjs"),
    [
      'const fs = require("node:fs");',
      `const CHANNEL_ID = ${JSON.stringify(CHANNEL_ID)};`,
      `const inboxPath = ${JSON.stringify(params.inboxPath)};`,
      `const tracePath = ${JSON.stringify(params.tracePath)};`,
      "let cursor = 0;",
      "let draining = false;",
      "let timer;",
      "let sequence = 0;",
      "const tails = new Map();",
      "const inflight = new Set();",
      "const log = (entry) => fs.appendFileSync(tracePath, JSON.stringify(entry) + '\\n');",
      "module.exports = {",
      "  id: CHANNEL_ID,",
      "  register(api) {",
      "    const dispatchEvent = async (input, lifecycle) => {",
      "      const chatId = input.chatId;",
      "      const target = `direct:${chatId}`;",
      "      const sessionKey = `agent:qa:${CHANNEL_ID}:direct:${chatId}`;",
      "      log({ event: 'dispatch-start', id: input.id, text: input.text });",
      "      const ctxPayload = api.runtime.channel.inbound.buildContext({",
      "        channel: CHANNEL_ID,",
      "        accountId: 'default',",
      "        messageId: input.id,",
      "        messageIdFull: input.id,",
      "        timestamp: Date.now(),",
      "        from: target,",
      "        sender: { id: 'fixture-user', name: 'Fixture User' },",
      "        conversation: { kind: 'direct', id: chatId, label: chatId },",
      "        route: {",
      "          agentId: 'qa',",
      "          dmScope: 'per-peer',",
      "          accountId: 'default',",
      "          routeSessionKey: sessionKey,",
      "          dispatchSessionKey: sessionKey,",
      "        },",
      "        reply: { to: target, originatingTo: target },",
      "        message: {",
      "          body: input.text,",
      "          bodyForAgent: input.text,",
      "          rawBody: input.text,",
      "          commandBody: input.text,",
      "        },",
      "        access: {",
      "          commands: { authorized: true },",
      "          mentions: { canDetectMention: false, wasMentioned: false },",
      "        },",
      "      });",
      "      return await api.runtime.channel.inbound.dispatch({",
      "        cfg: api.config,",
      "        channel: CHANNEL_ID,",
      "        accountId: 'default',",
      "        route: { agentId: 'qa', dmScope: 'per-peer', sessionKey },",
      "        ctxPayload,",
      "        replyOptions: {",
      "          turnAdoptionLifecycle: lifecycle,",
      "          allowToolLifecycleWhenProgressHidden: true,",
      "          onToolStart: (payload) => log({ event: 'tool-start', id: input.id, text: payload.name }),",
      "        },",
      "        delivery: {",
      "          deliver: async (payload, info) => {",
      "            const text = payload && typeof payload === 'object' && 'text' in payload ? payload.text || '' : '';",
      "            log({ event: 'delivery', id: input.id, kind: info && info.kind || 'final', text });",
      "          },",
      "          onError: (error) => log({ event: 'delivery-error', id: input.id, text: String(error) }),",
      "        },",
      "        replyPipeline: {},",
      "        record: { onRecordError: (error) => { throw error; } },",
      "      });",
      "    };",
      "    const receive = (input) => {",
      "      let finish;",
      "      let fail;",
      "      const completion = new Promise((resolve, reject) => { finish = resolve; fail = reject; });",
      "      const previous = tails.get(input.chatId) || Promise.resolve();",
      "      const admit = async () => {",
      "        let released = false;",
      "        let release;",
      "        const adopted = new Promise((resolve) => {",
      "          release = () => { if (!released) { released = true; resolve(); } };",
      "        });",
      "        const lifecycle = {",
      "          admission: 'exclusive',",
      "          onAdopted: () => { log({ event: 'adopted', id: input.id }); release(); },",
      "          onDeferred: () => { log({ event: 'deferred', id: input.id }); release(); },",
      "          onAbandoned: () => { log({ event: 'abandoned', id: input.id }); release(); },",
      "        };",
      "        const dispatch = Promise.resolve().then(() => dispatchEvent(input, lifecycle));",
      "        inflight.add(dispatch);",
      "        void dispatch.then(",
      "          (value) => { log({ event: 'dispatch-settled', id: input.id }); finish(value); },",
      "          (error) => { log({ event: 'dispatch-error', id: input.id, text: String(error) }); fail(error); },",
      "        ).finally(() => { inflight.delete(dispatch); release(); });",
      "        await adopted;",
      "      };",
      "      const tail = previous.then(admit, admit);",
      "      tails.set(input.chatId, tail);",
      "      void tail.finally(() => { if (tails.get(input.chatId) === tail) tails.delete(input.chatId); });",
      "      return completion;",
      "    };",
      "    const drain = async () => {",
      "      if (draining) return;",
      "      draining = true;",
      "      try {",
      "        let text = '';",
      "        try { text = fs.readFileSync(inboxPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }",
      "        const complete = text.endsWith('\\n') ? text : text.slice(0, text.lastIndexOf('\\n') + 1);",
      "        const next = complete.slice(cursor);",
      "        cursor = complete.length;",
      "        for (const line of next.split('\\n').filter(Boolean)) {",
      "          const task = receive(JSON.parse(line));",
      "          void task.catch(() => {});",
      "        }",
      "      } finally { draining = false; }",
      "    };",
      "    api.registerChannel({",
      "      plugin: {",
      "        id: CHANNEL_ID,",
      "        meta: { id: CHANNEL_ID, label: 'Ask User Adoption Proof', selectionLabel: 'Ask User Adoption Proof', docsPath: '/channels/proof', blurb: 'Synthetic proof channel.' },",
      "        capabilities: { chatTypes: ['direct'] },",
      "        config: {",
      "          listAccountIds: () => ['default'],",
      "          resolveAccount: (_cfg, accountId) => ({ accountId: accountId || 'default' }),",
      "          isEnabled: () => true,",
      "          isConfigured: () => true,",
      "        },",
      "        outbound: {",
      "          deliveryMode: 'direct',",
      "          sendText: async ({ to, text }) => {",
      "            sequence += 1;",
      "            log({ event: 'outbound-adapter', id: `outbound-${sequence}`, text, to });",
      "            return { channel: CHANNEL_ID, messageId: `proof-${sequence}` };",
      "          },",
      "        },",
      "        gateway: {",
      "          startAccount: async (ctx) => {",
      "            log({ event: 'service-started' });",
      "            ctx.setStatus({ accountId: 'default', running: true, connected: true, configured: true, enabled: true, lifecycle: 'ready' });",
      "            timer = setInterval(() => { void drain(); }, 10);",
      "            await new Promise((resolve) => ctx.abortSignal.addEventListener('abort', resolve, { once: true }));",
      "            clearInterval(timer);",
      "            await Promise.allSettled([...inflight]);",
      "            log({ event: 'service-stopped' });",
      "          },",
      "        },",
      "      },",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

async function appendInbound(
  inboxPath: string,
  input: { id: string; chatId: string; text: string },
) {
  await fs.appendFile(inboxPath, `${JSON.stringify(input)}\n`);
}

async function readTrace(tracePath: string): Promise<TraceEntry[]> {
  try {
    return (await fs.readFile(tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

describe("third-party channel ask_user adoption", () => {
  it("accepts plain text during a waiting turn and keeps control commands on core dispatch", async () => {
    const tempRoot = tempDirs.make("ask-user-adoption-proof-");
    const pluginDir = path.join(tempRoot, "plugin");
    const inboxPath = path.join(tempRoot, "inbox.jsonl");
    const tracePath = path.join(tempRoot, "trace.jsonl");
    await writeProofPlugin({ pluginDir, inboxPath, tracePath });

    const owner = createQaLiveLaneGateway();
    gatewayOwners.push(owner);
    const harness = await owner.start({
      repoRoot: REPO_ROOT,
      providerMode: "mock-openai",
      primaryModel: MODEL,
      alternateModel: MODEL_ALT,
      forcedRuntime: "openclaw",
      transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      mutateConfig: (cfg) => ({
        ...cfg,
        logging: { ...cfg.logging, level: "debug" },
        commands: {
          ...cfg.commands,
          ownerAllowFrom: [`${CHANNEL_ID}:fixture-user`],
        },
        plugins: {
          ...cfg.plugins,
          allow: [...(cfg.plugins?.allow ?? []), CHANNEL_ID],
          load: { paths: [pluginDir] },
          entries: { ...cfg.plugins?.entries, [CHANNEL_ID]: { enabled: true } },
        },
      }),
    });

    await expect
      .poll(() => readTrace(tracePath), { timeout: 30_000, interval: 25 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ event: "service-started" })]));
    const cursorResponse = await fetch(`${harness.mock?.baseUrl}/debug/request-cursor`);
    const { cursor } = (await cursorResponse.json()) as { cursor: number };

    await appendInbound(inboxPath, {
      id: "answer-question",
      chatId: "answer-chat",
      text: "QA_ADOPTION_ANSWER tool search qa check target=ask_user ask_user_fixture=single. Ask the question.",
    });
    await expect
      .poll(() => readTrace(tracePath), { timeout: 60_000, interval: 50 })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "adopted", id: "answer-question" }),
          expect.objectContaining({ event: "tool-start", id: "answer-question", text: "ask_user" }),
          expect.objectContaining({ event: "delivery", id: "answer-question" }),
        ]),
      );
    await expect
      .poll(
        async () => {
          const listed = (await harness.gateway.call("question.list", {})) as {
            questions?: Array<{ sessionKey?: string; status?: string }>;
          };
          return listed.questions?.some(
            (question) =>
              question.sessionKey === `agent:qa:${CHANNEL_ID}:direct:answer-chat` &&
              question.status === "pending",
          );
        },
        { timeout: 30_000, interval: 25 },
      )
      .toBe(true);
    await appendInbound(inboxPath, { id: "plain-answer", chatId: "answer-chat", text: "没事" });
    await expect
      .poll(
        () =>
          readTrace(tracePath).then((entries) =>
            entries.some(
              (entry) => entry.event === "dispatch-settled" && entry.id === "answer-question",
            ),
          ),
        { timeout: 60_000, interval: 50 },
      )
      .toBe(true);
    const answerTrace = await readTrace(tracePath);
    if (
      answerTrace.some(
        (entry) => entry.id === "answer-question" && entry.text?.includes("Agent run failed"),
      )
    ) {
      process.stdout.write(`ANSWER_TRACE ${JSON.stringify(answerTrace)}\n`);
      const history = (await harness.gateway.call("chat.history", {
        sessionKey: `agent:qa:${CHANNEL_ID}:direct:answer-chat`,
        limit: 50,
      })) as { messages?: Array<Record<string, unknown>> };
      const historySummary = history.messages?.map((message) => ({
        role: message.role,
        senderIsOwner: message.senderIsOwner,
        content: message.content,
      }));
      const questions = await harness.gateway.call("question.list", {});
      const relevantLogs = harness.gateway
        .logs()
        .split("\n")
        .filter((line) =>
          /ask_user|question|queue|steer|inject|authority|failed|abort/i.test(line),
        );
      process.stdout.write(`ANSWER_HISTORY ${JSON.stringify(historySummary)}\n`);
      process.stdout.write(`QUESTIONS ${JSON.stringify(questions)}\n`);
      process.stdout.write(`GATEWAY_LOGS ${JSON.stringify(relevantLogs)}\n`);
      throw new Error("answer dispatch failed; diagnostics printed above");
    }
    await expect
      .poll(() => readTrace(tracePath), { timeout: 60_000, interval: 50 })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "dispatch-start", id: "plain-answer" }),
          expect.objectContaining({ event: "dispatch-settled", id: "plain-answer" }),
          expect.objectContaining({
            event: "delivery",
            id: "answer-question",
            text: expect.stringContaining("ASK-USER-SINGLE-OK | deploy=没事"),
          }),
          expect.objectContaining({ event: "dispatch-settled", id: "answer-question" }),
        ]),
      );

    await appendInbound(inboxPath, {
      id: "control-question",
      chatId: "control-chat",
      text: "QA_ADOPTION_CONTROL tool search qa check target=ask_user ask_user_fixture=single. Ask the question.",
    });
    await expect
      .poll(() => readTrace(tracePath), { timeout: 60_000, interval: 50 })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "adopted", id: "control-question" }),
          expect.objectContaining({
            event: "tool-start",
            id: "control-question",
            text: "ask_user",
          }),
        ]),
      );
    await expect
      .poll(
        async () => {
          const listed = (await harness.gateway.call("question.list", {})) as {
            questions?: Array<{ sessionKey?: string; status?: string }>;
          };
          return listed.questions?.some(
            (question) =>
              question.sessionKey === `agent:qa:${CHANNEL_ID}:direct:control-chat` &&
              question.status === "pending",
          );
        },
        { timeout: 30_000, interval: 25 },
      )
      .toBe(true);
    await appendInbound(inboxPath, { id: "control-stop", chatId: "control-chat", text: "/stop" });
    await expect
      .poll(() => readTrace(tracePath), { timeout: 60_000, interval: 50 })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "dispatch-start", id: "control-stop" }),
          expect.objectContaining({ event: "dispatch-settled", id: "control-stop" }),
        ]),
      );

    const requestsResponse = await fetch(`${harness.mock?.baseUrl}/debug/requests?after=${cursor}`);
    const requests = (await requestsResponse.json()) as MockOpenAiRequestSnapshot[];
    const initialRequests = requests.filter((request) => request.requestKind === "agent-initial");
    const trace = await readTrace(tracePath);
    const controlDeliveries = trace.filter(
      (entry) => entry.event === "delivery" && entry.id === "control-stop",
    );
    const evidence = {
      kind: "external-plugin-public-channel-dispatch",
      publicEntryPoint: "api.runtime.channel.inbound.dispatch",
      answer: {
        adoptedBeforeAnswer:
          trace.findIndex((entry) => entry.event === "adopted" && entry.id === "answer-question") <
          trace.findIndex(
            (entry) => entry.event === "dispatch-start" && entry.id === "plain-answer",
          ),
        status: "answered",
        text: "没事",
        secondAgentTurn: initialRequests.filter((request) => request.allInputText.includes("没事"))
          .length,
        originatingFinal: trace.some(
          (entry) => entry.id === "answer-question" && entry.text?.includes("deploy=没事"),
        ),
      },
      control: {
        command: "/stop",
        dispatchedByCore: trace.some(
          (entry) => entry.event === "dispatch-settled" && entry.id === "control-stop",
        ),
        deliveredReply: controlDeliveries.map((entry) => entry.text),
        consumedAsQuestionAnswer: trace.some(
          (entry) => entry.id === "control-question" && entry.text?.includes("deploy=/stop"),
        ),
      },
      initialAgentTurns: initialRequests.length,
    };
    process.stdout.write(`ASK_USER_ADOPTION_PROOF ${JSON.stringify(evidence)}\n`);
    expect(evidence.answer).toMatchObject({
      adoptedBeforeAnswer: true,
      status: "answered",
      secondAgentTurn: 0,
      originatingFinal: true,
    });
    expect(evidence.control).toMatchObject({
      command: "/stop",
      dispatchedByCore: true,
      consumedAsQuestionAnswer: false,
    });
  }, 180_000);
});
