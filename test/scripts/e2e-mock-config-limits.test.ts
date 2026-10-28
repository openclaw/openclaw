import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, type TestContext, vi } from "vitest";
import { validateToolArguments } from "../../packages/llm-core/src/validation.js";
import { execSchema } from "../../src/agents/bash-tools.schemas.js";
import { createCodeModeTools } from "../../src/agents/code-mode.js";
import { writeJsonAtomic } from "../../src/infra/json-files.js";
import { redactSensitiveText } from "../../src/logging/redact.js";
import { captureFullEnv } from "../../src/test-utils/env.js";
import { getFreePort } from "../../src/test-utils/ports.js";
import { withTempDir } from "../../src/test-utils/temp-dir.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "../helpers/promise.js";
import { runSqliteSessionsTranscriptsFlipProof } from "../helpers/sqlite-sessions-transcripts-flip-proof.js";
import { stopChildProcess } from "../helpers/stop-child-process.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("../helpers/openclaw-test-instance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers/openclaw-test-instance.js")>();
  return { ...actual, createOpenClawTestInstance: vi.fn(actual.createOpenClawTestInstance) };
});
vi.mock("../helpers/stop-child-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers/stop-child-process.js")>();
  return { ...actual, stopChildProcess: vi.fn(actual.stopChildProcess) };
});

function post(baseUrl: string, body: unknown, route = "responses") {
  return fetch(`${baseUrl}/v1/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseEvents(body: string) {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

function responseBody(events: ReturnType<typeof parseEvents>, stream: boolean) {
  return stream ? events.find((event) => event.type === "response.completed").response : events[0];
}
function responseItems(events: ReturnType<typeof parseEvents>, stream: boolean) {
  return stream
    ? events
        .filter((event) => event.type === "response.output_item.done")
        .map((event) => event.item)
    : events[0].output;
}
function chatMessages(events: ReturnType<typeof parseEvents>, stream: boolean) {
  return events.map((chunk) => (stream ? chunk.choices[0].delta : chunk.choices[0].message));
}
function apiText(events: ReturnType<typeof parseEvents>, api: string, stream: boolean) {
  return api === "responses"
    ? responseBody(events, stream).output[0].content[0].text
    : chatMessages(events, stream)
        .map((message) => message.content ?? "")
        .join("");
}
const functionTool = (name: string, parameters: unknown = { type: "object" }) => ({
  name,
  parameters,
  type: "function",
});
const inputMessage = (content: unknown, role = "user") => ({ role, content });
const contentMessage = (content: unknown, role = "user") => ({
  type: "message",
  ...inputMessage(content, role),
});
const textMessage = (text: string, role = "user") =>
  contentMessage([{ type: "input_text", text }], role);
const runtimeText = (text: string) =>
  `OpenClaw runtime context:\n${text}\nEnd OpenClaw runtime context.`;
const internalText = (text: string) =>
  `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${text}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
async function requestApi(
  baseUrl: string,
  api: string,
  stream: boolean,
  turns: unknown[],
  extra: { model?: string; tools?: unknown[] } = {},
  assert: TestContext["expect"] = expect,
) {
  const response = await post(
    baseUrl,
    {
      ...extra,
      [api === "responses" ? "input" : "messages"]: turns,
      stream,
    },
    api,
  );
  assert(response.status).toBe(200);
  return stream ? parseEvents(await response.text()) : [await response.json()];
}
async function requestResponse(
  baseUrl: string,
  input: unknown,
  extra: { model?: string; tools?: unknown[] } = {},
) {
  const response = await post(baseUrl, { input, stream: false, ...extra });
  expect(response.status).toBe(200);
  return response.json();
}
const parseEntries = (body: string) =>
  body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const toolResult = (output: unknown) => ({
  type: "function_call_output",
  output: typeof output === "string" ? output : JSON.stringify(output),
});
const responseText = (body: { output?: { content?: { text?: string }[] }[] }) =>
  body.output?.[0]?.content?.[0]?.text;
const codeModeFailure =
  "MCP_CODE_MODE_FILE_FAIL unclear=code-mode-exec-did-not-return-fixture-note";

const mockOpenAiPath = "scripts/e2e/mock-openai-server.mjs";
const webSearchMockPath = "scripts/e2e/lib/openai-web-search-minimal/mock-server.mjs";
const scrubbedEnvKeys = [
  "CLICKCLACK_FIXTURE_PORT",
  "CLICKCLACK_FIXTURE_REQUEST_MAX_BYTES",
  "FIXTURE_PORT",
  "MOCK_BIND_HOST",
  "MOCK_PORT",
  "MOCK_REQUEST_LOG",
  "MOCK_RESPONSE_CHUNK_DELAY_MS",
  "MOCK_RESPONSE_CONTROL",
  "MOCK_TLS_CERT",
  "MOCK_TLS_KEY",
  "OPENCLAW_CONFIG_RELOAD_LOG_MAX_READ_BYTES",
  "OPENCLAW_CONFIG_RELOAD_LOG_PATH",
  "OPENCLAW_CONFIG_RELOAD_LOG_TIMEOUT_MS",
  "OPENCLAW_MOCK_OPENAI_PORT",
  "RAW_SCHEMA_ERROR",
  "SUCCESS_MARKER",
];

function cleanEnv(env: Record<string, string>) {
  const childEnv = { ...process.env };
  for (const key of scrubbedEnvKeys) {
    delete childEnv[key];
  }
  return { ...childEnv, ...env };
}

function runScript(scriptPath: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: cleanEnv(env),
    killSignal: "SIGKILL",
    timeout: 3_000,
  });
}

async function waitForListening(
  child: ChildProcess,
  port: number,
  output: () => string,
  stderr: () => string,
  signal: AbortSignal,
) {
  const listening = createDeferred<number>();
  let exited = false;
  const failure = (message: string) =>
    new Error(
      `${message}\nstdout tail:\n${redactSensitiveText(output(), { mode: "tools" }).slice(-4_096)}\nstderr tail:\n${redactSensitiveText(stderr(), { mode: "tools" }).slice(-4_096)}`,
    );
  const checkListening = () => {
    if (exited) {
      return;
    }
    const match = /(?:^|\n)mock-openai listening on ([1-9]\d{0,4})(?: \(HTTPS?\))?\r?\n/u.exec(
      output(),
    );
    if (match) {
      const boundPort = Number(match[1]);
      if (boundPort <= 65_535 && (port === 0 || port === boundPort)) {
        listening.resolve(boundPort);
      }
    }
  };
  const onExit = () => {
    exited = true;
  };
  const onClose = (code: number | null, childSignal: NodeJS.Signals | null) => {
    listening.reject(
      failure(`mock server exited before listening: code=${code} signal=${childSignal}`),
    );
  };
  child.stdout?.on("data", checkListening);
  child.once("exit", onExit);
  // Close follows stdio drain; exit can arrive before the final diagnostic chunk.
  child.once("close", onClose);
  checkListening();
  try {
    return await withinTest(listening.promise, signal);
  } finally {
    child.stdout?.off("data", checkListening);
    child.off("exit", onExit);
    child.off("close", onClose);
  }
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit").then(() => undefined);
  // Both mock servers use Node's default SIGTERM action; the owned exit joins termination.
  child.kill("SIGTERM");
  await exited;
}

async function withMockServer(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  run: (baseUrl: string, stderr: () => string) => Promise<void>,
  env: Record<string, string> = {},
  scriptPath = mockOpenAiPath,
) {
  const port = Number(env.MOCK_PORT ?? "0");
  let stderr = "";
  let stdout = "";
  const child = spawn(process.execPath, [scriptPath], {
    env: cleanEnv({ ...env, MOCK_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stopped: Promise<void> | undefined;
  const stop = () => (stopped ??= stopServer(child));
  // A timed-out body resumes finally, but Vitest only joins registered cleanup.
  context.onTestFinished(stop);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    const boundPort = await waitForListening(
      child,
      port,
      () => stdout,
      () => stderr,
      context.signal,
    );
    await run(`http://127.0.0.1:${boundPort}`, () => stderr);
  } finally {
    await stop();
  }
}

async function withControl(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  initial: unknown,
  run: (baseUrl: string, paths: { control: string; requestLog: string }) => Promise<void>,
  logRequests = false,
  env: Record<string, string> = {},
) {
  await withTempDir("openclaw-mock-control-", async (root) => {
    const control = join(root, "response.json");
    const requestLog = join(root, "requests.ndjson");
    await writeFile(control, JSON.stringify(initial));
    if (logRequests) {
      await writeFile(requestLog, "");
    }
    await withMockServer(context, (baseUrl) => run(baseUrl, { control, requestLog }), {
      ...env,
      MOCK_RESPONSE_CONTROL: control,
      ...(logRequests ? { MOCK_REQUEST_LOG: requestLog } : {}),
    });
  });
}

describe("mock OpenAI response markers", () => {
  it.for([false, true])(
    "drives one Telegram topic spawn and current-turn acknowledgments (stream=%s)",
    async (stream, ctx) => {
      await withMockServer(ctx, async (baseUrl) => {
        const run = "topic-proof";
        const marker = (phase: string, id = run) => `TELEGRAM_BINDING_${phase}_${id}`;
        const user = (text: string) => inputMessage([{ type: "input_text", text }]);
        const create = user(marker("SPAWN"));
        const tools = [functionTool("sessions_spawn")];
        const context = user(internalText("Runtime facts."));
        const currentContextText = runtimeText("Runtime facts.");
        const currentContext = stream
          ? user(currentContextText)
          : { role: "user", content: currentContextText };
        const request = async (input: unknown[], declaredTools: unknown[] = tools) =>
          responseBody(
            await requestApi(baseUrl, "responses", stream, input, {
              model: "fixture-agent",
              tools: declaredTools,
            }),
            stream,
          ).output;
        const expectText = async (input: unknown[], text: string, declaredTools = tools) => {
          expect(await request(input, declaredTools)).toEqual([
            expect.objectContaining({
              type: "message",
              content: [{ type: "output_text", text, annotations: [] }],
            }),
          ]);
        };

        // Utility traffic must not consume the spawn slot.
        await expectText([user("ordinary startup request")], "OPENCLAW_E2E_OK");
        const first = await request([create, context, currentContext]);
        expect(first).toHaveLength(1);
        const call = first[0];
        expect(call).toMatchObject({ type: "function_call", name: "sessions_spawn" });
        const args = JSON.parse(call.arguments);
        expect(args).toEqual({
          task: `TELEGRAM_BINDING_CHILD_${run}. Reply with the child fixture acknowledgment.`,
          taskName: `telegram-binding-${run}`,
          runtime: "subagent",
          thread: true,
          mode: "session",
          cleanup: "keep",
          context: "isolated",
        });
        await expectText([create], marker("WAITING"));

        const receipt = {
          call_id: call.call_id,
          ...toolResult({
            status: "accepted",
            childSessionKey: "agent:main:subagent:synthetic-child",
            taskName: args.taskName,
            mode: "session",
          }),
        };
        const completed = [create, call, receipt, context, currentContext];
        await expectText(completed, marker("ACK_PARENT"));
        await expectText([create, call, { ...receipt, call_id: "unrelated" }], marker("WAITING"));
        await expectText(
          [create, call, { ...receipt, output: '{"status":"error"}' }],
          marker("FAIL_SPAWN"),
        );

        for (const phase of ["CHILD", "BEFORE", "AFTER"]) {
          await expectText(
            [...completed, user(`TELEGRAM_BINDING_${phase}_${run}`), context, currentContext],
            `TELEGRAM_BINDING_ACK_${phase}_${run}`,
          );
        }
        await expectText(
          [...completed, user("ordinary later request"), currentContext],
          "OPENCLAW_E2E_OK",
        );
        // Carrier boundary variants belong to the mock-inference-facts owner test.
        await expectText(
          [
            ...completed,
            user("OpenClaw runtime context:\nTELEGRAM_BINDING_CHILD_boundary"),
            currentContext,
          ],
          marker("ACK_CHILD", "boundary"),
        );
        const unsupported = inputMessage([
          { type: "text", text: "TELEGRAM_BINDING_CHILD_unsupported" },
        ]);
        await expectText([...completed, unsupported, currentContext], "OPENCLAW_E2E_OK");
        const history = `[Chat messages since your last reply - for context]\n${marker("SPAWN")}\n\n[Current message - respond to this]\nordinary latest message`;
        await expectText([user(history), currentContext], "OPENCLAW_E2E_OK");
        await expectText(
          [user(`TELEGRAM_BINDING_SPAWN_${run} TELEGRAM_BINDING_CHILD_${run}`)],
          "TELEGRAM_BINDING_FAIL_AMBIGUOUS_MARKER",
        );

        // An old successful receipt cannot acknowledge or suppress a distinct new turn.
        await expectText(
          [user(marker("SPAWN", "second-proof"))],
          marker("FAIL_TOOL_NOT_DECLARED", "second-proof"),
          [],
        );
        const next = await request([...completed, user(marker("SPAWN", "second-proof"))]);
        expect(next).toHaveLength(1);
        expect(next[0]).toMatchObject({ type: "function_call", name: "sessions_spawn" });
        expect(JSON.parse(next[0].arguments).taskName).toBe("telegram-binding-second-proof");
        const health = await (await fetch(`${baseUrl}/health`)).json();
        expect(health.requests.selections.automaticTool).toBe(2);
      });
    },
  );

  it.concurrent.for([
    { api: "responses", stream: false },
    { api: "responses", stream: true },
    { api: "chat/completions", stream: false },
    { api: "chat/completions", stream: true },
  ])(
    "emits native exec draft-proof calls from $api (stream=$stream)",
    async ({ api, stream }, ctx) => {
      const { expect: taskExpect } = ctx;
      await withMockServer(
        ctx,
        async (baseUrl) => {
          const user = inputMessage("return OPENCLAW_E2E_DRAFTPROOF");
          const tool = {
            name: "exec",
            description: "Execute a shell command",
            parameters: execSchema,
          };
          const request = (turns: unknown[], model = "fixture-agent") =>
            requestApi(
              baseUrl,
              api,
              stream,
              turns,
              {
                model,
                tools: [
                  api === "responses"
                    ? { type: "function", ...tool }
                    : { type: "function", function: tool },
                ],
              },
              taskExpect,
            );

          const first = await request([user]);
          let call;
          let assistant;
          if (api === "responses") {
            const items = responseItems(first, stream);
            taskExpect(items).toHaveLength(2);
            taskExpect(items[0]).toMatchObject({
              type: "message",
              phase: "commentary",
              content: [{ type: "output_text", text: "Checking the workspace before answering." }],
            });
            call = items[1];
            taskExpect(call).toMatchObject({ type: "function_call", name: "exec" });
            assistant = items;
          } else {
            const messages = chatMessages(first, stream);
            const toolIndex = messages.findIndex((message) => message.tool_calls?.length);
            taskExpect(toolIndex).toBeGreaterThanOrEqual(0);
            taskExpect(
              messages
                .slice(0, toolIndex + 1)
                .map((message) => message.content ?? "")
                .join(""),
            ).toBe("Checking the workspace before answering.");
            taskExpect(messages.slice(toolIndex + 1).some((message) => message.content)).toBe(
              false,
            );
            const toolCalls = messages[toolIndex].tool_calls;
            taskExpect(toolCalls).toHaveLength(1);
            call = { ...toolCalls[0].function, call_id: toolCalls[0].id };
            taskExpect(call.name).toBe("exec");
            assistant = [
              {
                ...inputMessage("Checking the workspace before answering.", "assistant"),
                tool_calls: toolCalls,
              },
            ];
          }

          // A final marker alone would not prove the emitted call matches the native schema.
          const args = JSON.parse(call.arguments);
          validateToolArguments(tool, {
            type: "toolCall",
            id: call.call_id,
            name: call.name,
            arguments: args,
          });
          taskExpect(args.command).toBe("sleep 2 && echo openclaw-draft-proof");
          const toolOutput = "openclaw-draft-proof\n";

          const finalStartedAt = performance.now();
          const facts = runtimeText("Current conversation facts");
          const runtimeContext = inputMessage(
            stream ? [{ type: api === "responses" ? "input_text" : "text", text: facts }] : facts,
          );
          const completedTurn = [
            user,
            ...assistant,
            api === "responses"
              ? { type: "function_call_output", call_id: call.call_id, output: toolOutput }
              : { role: "tool", tool_call_id: call.call_id, content: toolOutput },
            runtimeContext,
          ];
          const final = await request(completedTurn);
          taskExpect(apiText(final, api, stream)).toBe("OPENCLAW_E2E_DRAFTPROOF");
          if (api !== "responses") {
            taskExpect(performance.now() - finalStartedAt).toBeGreaterThanOrEqual(60);
          }

          const followup = await request([
            ...completedTurn,
            { role: "assistant", content: "OPENCLAW_E2E_DRAFTPROOF" },
            { role: "user", content: "repeat OPENCLAW_E2E_DRAFTPROOF for this next turn" },
            runtimeContext,
          ]);
          if (api === "responses") {
            const items = responseItems(followup, stream);
            taskExpect(items).toContainEqual(
              taskExpect.objectContaining({ type: "function_call", name: "exec" }),
            );
          } else {
            const calls = chatMessages(followup, stream).flatMap(
              (message) => message.tool_calls ?? [],
            );
            taskExpect(calls).toContainEqual(
              taskExpect.objectContaining({
                function: taskExpect.objectContaining({ name: "exec" }),
              }),
            );
          }
          const health = await (await fetch(`${baseUrl}/health`)).json();
          taskExpect(health.requests.selections).toEqual({
            model: 0,
            global: 0,
            automaticTool: 2,
            automaticText: 1,
          });
        },
        { MOCK_DRAFTPROOF_FINAL_DELAY_MS: "80" },
      );
    },
  );

  it("counts ingress independently of body rejection and excludes health/catalog probes", async (ctx) => {
    await withMockServer(
      ctx,
      async (baseUrl) => {
        const initial = await (await fetch(`${baseUrl}/health`)).json();
        await (await fetch(`${baseUrl}/v1/models`)).text();
        const rejected = await fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          body: "x".repeat(129),
        });
        expect(rejected.status).toBe(413);
        await rejected.text();
        await (
          await fetch(`${baseUrl}/v1/embeddings`, {
            method: "POST",
            body: JSON.stringify({ input: "sample" }),
          })
        ).text();
        await (await fetch(`${baseUrl}/missing`, { method: "POST" })).text();
        const final = await (await fetch(`${baseUrl}/health`)).json();
        expect(final.requests.id).toBe(initial.requests.id);
        expect(initial.requests.ingress).toEqual({
          responses: 0,
          chatCompletions: 0,
          embeddings: 0,
          other: 0,
        });
        expect(final.requests.ingress).toEqual({
          responses: 1,
          chatCompletions: 0,
          embeddings: 1,
          other: 1,
        });
        expect(final.requests.selections).toEqual({
          model: 0,
          global: 0,
          automaticTool: 0,
          automaticText: 0,
        });
      },
      { OPENCLAW_MOCK_OPENAI_REQUEST_MAX_BYTES: "128" },
    );
  });

  it("matches only own model keys and rejects mixed global/map controls", async (ctx) => {
    await withControl(
      ctx,
      { models: { arbitrary: { text: "mapped" } } },
      async (baseUrl, { control }) => {
        const mapped = await requestResponse(baseUrl, "return OPENCLAW_E2E_DRAFTPROOF", {
          model: "arbitrary",
          tools: [functionTool("exec", execSchema)],
        });
        expect(responseText(mapped)).toBe("mapped");
        const request = () => post(baseUrl, { model: "toString", input: "hello", stream: false });
        expect((await (await request()).json()).output[0].content[0].text).toBe("OPENCLAW_E2E_OK");
        await writeFile(
          control,
          JSON.stringify({ models: { arbitrary: { text: "mapped" } }, text: "global" }),
        );
        const response = await request();
        expect(response.status).toBe(500);
        expect(await response.text()).toContain("exclusive nonempty map");
      },
    );
  });

  it("echoes dynamic OpenClaw E2E and update serving markers", async (ctx) => {
    await withMockServer(ctx, async (baseUrl) => {
      const servingMarker = "update-verified-67a60fb5-203d-4d08-bfba-6f5a053af61b";
      const servingPrompt = `This is an OpenClaw update serving check. Do not use tools. Reply with exactly: ${servingMarker}`;
      for (const marker of ["OPENCLAW_E2E_SEED_0_123", "OPENCLAW_E2E_ANDROID_OK", servingMarker]) {
        const prompt = marker === servingMarker ? servingPrompt : `Reply exactly with ${marker}.`;
        expect(responseText(await requestResponse(baseUrl, prompt))).toBe(marker);
      }

      const currentMarker = "OPENCLAW_E2E_SEED_2_333";
      const olderMarker = "OPENCLAW_E2E_SEED_1_222";
      const toolMarker = "OPENCLAW_E2E_TOOL_RESULT";
      const context = internalText(`Earlier reply: ${olderMarker}`);
      for (const route of ["responses", "chat/completions"] as const) {
        for (const stream of [false, true]) {
          const user = (text: string) =>
            inputMessage(
              stream ? [{ type: route === "responses" ? "input_text" : "text", text }] : text,
            );
          const current = user(`Reply exactly with ${currentMarker}.`);
          const toolOutput =
            route === "responses"
              ? { type: "function_call_output", call_id: "fixture-call", output: toolMarker }
              : { role: "tool", tool_call_id: "fixture-call", content: toolMarker };
          const markerCases: [unknown[], string][] = [
            [[current, user(context)], currentMarker],
            [
              [
                current,
                user(`<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nEarlier reply: ${olderMarker}`),
              ],
              olderMarker,
            ],
            [[current, inputMessage(olderMarker, "assistant"), user(context)], olderMarker],
            [[current, toolOutput, user(context)], toolMarker],
            [[user(servingPrompt), toolOutput, user(context)], servingMarker],
          ];
          for (const [messages, marker] of markerCases) {
            expect(apiText(await requestApi(baseUrl, route, stream, messages), route, stream)).toBe(
              marker,
            );
          }
        }
        const malformed = await fetch(`${baseUrl}/v1/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"input":"${currentMarker}", broken`,
        });
        expect(malformed.status).toBe(200);
        expect(await malformed.text()).toContain(currentMarker);
      }
    });
  });

  it("can split a deterministic response across delayed streaming deltas", async (ctx) => {
    await withMockServer(
      ctx,
      async (baseUrl) => {
        const startedAt = Date.now();
        const response = await post(baseUrl, {
          input: "return the configured marker",
          stream: true,
        });
        const body = await response.text();

        expect(response.status).toBe(200);
        const events = parseEvents(body);
        expect(events.filter((event) => event.type === "response.output_text.delta")).toHaveLength(
          2,
        );
        expect(events.filter((event) => event.item?.type === "message")).toMatchObject([
          { type: "response.output_item.added", output_index: 0 },
          { type: "response.output_item.done", output_index: 0 },
        ]);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
      },
      {
        MOCK_RESPONSE_CHUNK_DELAY_MS: "80",
        SUCCESS_MARKER: "First streamed preview remains visible before the follow-up edit arrives.",
      },
    );
  });

  it("accepts delays above 60 seconds and reloads lane-owned controls between turns", async (ctx) => {
    await withControl(
      ctx,
      { chunkDelayMs: 60_001, text: "first response" },
      async (baseUrl, { control }) => {
        const request = () =>
          requestResponse(baseUrl, "return OPENCLAW_E2E_EDIT_FAILURE_UNRESOLVED");
        expect(responseText(await request())).toBe("first response");
        const completion = await requestApi(baseUrl, "chat/completions", false, [
          inputMessage("return OPENCLAW_E2E_DRAFTPROOF"),
        ]);
        expect(completion[0].choices?.[0]?.message?.content).toBe("first response");
        await writeFile(control, JSON.stringify({ chunkDelayMs: 0, text: "second response" }));
        expect(responseText(await request())).toBe("second response");
      },
    );
  });

  it("streams lane-owned raw Responses API events", async (ctx) => {
    const events = [
      { delta: "< / internal", type: "response.reasoning_text.delta" },
      { delta: "VISIBLE", type: "response.output_text.delta" },
      { response: { output: [], status: "completed" }, type: "response.completed" },
    ];
    await withControl(ctx, { events }, async (baseUrl) => {
      const response = await post(baseUrl, { input: "exercise raw events", stream: true });
      const body = await response.text();
      expect(response.status).toBe(200);
      for (const event of events) {
        expect(body).toContain(`data: ${JSON.stringify(event)}`);
      }
    });
  });

  it("streams a lane-owned chat tool call in argument chunks before its text", async (ctx) => {
    const args = { path: "turn-0.ts", content: "export const value = { ok: [1, 2] };" };
    await withControl(
      ctx,
      { text: "written", toolCall: { name: "write", arguments: args, argumentChunkChars: 4 } },
      async (baseUrl) => {
        const user = inputMessage("write the generated file");
        const calls = chatMessages(
          await requestApi(baseUrl, "chat/completions", true, [user]),
          true,
        ).flatMap((delta) => delta.tool_calls ?? []);
        const chunks = calls.map((call) => call.function.arguments);
        expect(calls[0]).toMatchObject({ type: "function", function: { name: "write" } });
        expect(Math.max(...chunks.map((chunk) => chunk.length))).toBe(4);
        expect(JSON.parse(chunks.join(""))).toStrictEqual(args);
        const final = await requestApi(baseUrl, "chat/completions", true, [
          user,
          { role: "assistant", tool_calls: [calls[0]] },
          { role: "tool", tool_call_id: calls[0].id, content: "ok" },
        ]);
        expect(apiText(final, "chat/completions", true)).toBe("written");
      },
    );
  });

  it("consumes scripted responses in order and logs the selected entries", async (ctx) => {
    const script = {
      scriptVersion: "script-1",
      hold: true,
      responses: [
        { text: "first response" },
        { fail: { status: 429, message: "OAuth token refresh failed for openai: invalid_grant" } },
        { text: "third response" },
      ],
      default: { text: "default response" },
    };
    await withControl(
      ctx,
      script,
      async (baseUrl, { control, requestLog }) => {
        const request = () => post(baseUrl, { input: "scripted turn", stream: false });
        let settled = false;
        const firstPromise = request().then((response) => {
          settled = true;
          return response;
        });
        await delay(75);
        expect(settled).toBe(false);
        // The held request polls this file; never expose a truncated control document.
        await writeJsonAtomic(control, { ...script, hold: false });
        const first = await firstPromise;
        expect(responseText(await first.json())).toBe("first response");
        const second = await request();
        expect(second.status).toBe(429);
        expect(await second.json()).toEqual({
          error: { message: "OAuth token refresh failed for openai: invalid_grant" },
        });
        const expectNext = async (text: string) =>
          expect(responseText(await (await request()).json())).toBe(text);
        await expectNext("third response");
        await expectNext("default response");
        await writeFile(
          control,
          JSON.stringify({ ...script, hold: false, scriptVersion: "script-2" }),
        );
        await expectNext("first response");
        await writeFile(
          control,
          JSON.stringify({ responses: [{ text: "last response" }], scriptVersion: "script-3" }),
        );
        await expectNext("last response");
        await expectNext("last response");
        const entries = parseEntries(await readFile(requestLog, "utf8"));
        expect(entries.map((entry) => entry.scriptEntry)).toEqual([
          { entryIndex: 0, requestIndex: 0, source: "responses" },
          { entryIndex: 1, requestIndex: 1, source: "responses" },
          { entryIndex: 2, requestIndex: 2, source: "responses" },
          { requestIndex: 3, source: "default" },
          { entryIndex: 0, requestIndex: 0, source: "responses" },
          { entryIndex: 0, requestIndex: 0, source: "responses" },
          { entryIndex: 0, requestIndex: 1, source: "last" },
        ]);
      },
      true,
    );
  });

  it("records bounded media facts without provider payload bytes", async (ctx) => {
    const pdfBytes = "private-pdf-bytes";
    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");
    await withTempDir("openclaw-mock-content-facts-", async (root) => {
      const requestLog = join(root, "requests.ndjson");
      await writeFile(requestLog, "");
      await withMockServer(
        ctx,
        async (baseUrl) => {
          const send = (input: unknown) => requestResponse(baseUrl, input);
          await send([
            contentMessage(
              Array.from({ length: 128 }, (_, index) => ({
                type: "input_text",
                text: `historical turn ${index}`,
              })),
            ),
            contentMessage([
              {
                type: "input_file",
                filename: "proof.pdf",
                file_data: `data:application/pdf;base64,${pdfBase64}`,
              },
              { type: "input_text", text: "Summarize the staged document." },
            ]),
          ]);
          await send([
            textMessage(
              "[media attached: /tmp/session/proof.pdf (application/pdf)]\nSummarize it.",
            ),
          ]);

          const recorded = await readFile(requestLog, "utf8");
          const entries = parseEntries(recorded);
          expect(entries[0]?.contentFacts).toHaveLength(128);
          expect(entries[0]?.contentFactsTruncated).toBe(true);
          expect(entries[0]?.contentFacts.slice(-2)).toEqual([
            {
              type: "input_file",
              filename: "proof.pdf",
              mimeType: "application/pdf",
              byteLength: Buffer.byteLength(pdfBytes),
            },
            { type: "input_text" },
          ]);
          expect(entries[1]?.contentFacts).toEqual([
            { type: "input_text" },
            {
              type: "legacy_media",
              filename: "/tmp/session/proof.pdf",
              mimeType: "application/pdf",
            },
          ]);
          expect(recorded).not.toContain(pdfBase64);
          expect(entries[0]?.body).toContain("data:application/pdf;base64,[redacted:17 bytes]");
          expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);

          // Redaction walks parsed JSON, so an unparseable body must never be
          // logged as raw text — that path would leak the base64 payload.
          const malformed = `{"input": "data:application/pdf;base64,${pdfBase64}"`;
          const response = await fetch(`${baseUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: malformed,
          });
          expect(response.status).toBe(200);
          const withMalformed = await readFile(requestLog, "utf8");
          expect(withMalformed).not.toContain(pdfBase64);
          const malformedEntry = parseEntries(withMalformed).at(-1);
          expect(malformedEntry?.body).toBe(
            `[unparseable request body redacted: ${Buffer.byteLength(malformed)} bytes]`,
          );
          expect(malformedEntry?.seq).toBe(3);
        },
        { MOCK_REQUEST_LOG: requestLog },
      );
    });
  });

  it("supports scripted connection drops", async (ctx) => {
    await withControl(
      ctx,
      { responses: [{ fail: { mode: "drop" } }], scriptVersion: "drop-1" },
      async (baseUrl) => {
        await expect(post(baseUrl, { input: "drop this turn", stream: false })).rejects.toThrow();
      },
    );
  });

  it("resumes the MCP Code Mode fixture", async (ctx) => {
    const tools = createCodeModeTools({});
    await withMockServer(ctx, async (baseUrl) => {
      const input: Record<string, unknown>[] = [inputMessage("mcp code mode api file qa check")];
      const request = async () => {
        const result = await requestResponse(baseUrl, input, {
          tools: tools.map(({ name, parameters }) => functionTool(name, parameters)),
        });
        for (const call of result.output ?? []) {
          if (call.type !== "function_call") {
            continue;
          }
          const tool = tools.find((entry) => entry.name === call.name);
          if (!tool) {
            throw new Error(`Mock emitted undeclared tool: ${call.name}`);
          }
          validateToolArguments(tool, {
            type: "toolCall",
            id: call.call_id,
            name: call.name,
            arguments: JSON.parse(call.arguments),
          });
        }
        return result;
      };
      const first = await request();
      expect(first.output?.[0]).toMatchObject({ name: "exec", type: "function_call" });
      const execArguments = JSON.parse(first.output[0].arguments);
      expect(execArguments).toEqual({
        title: expect.any(String),
        code: expect.stringContaining('MCP.fixture.lookupNote({ id: "alpha" })'),
      });
      expect(execArguments.code).toContain("catalog.all().some(");

      for (const reason of ["pending_tools", "yield"]) {
        input.push(toolResult({ status: "waiting", runId: "cm_fixture", reason, output: [] }));
        const pending = await request();
        expect(pending.output?.[0]).toMatchObject({
          arguments: JSON.stringify({ runId: "cm_fixture" }),
          name: "wait",
          type: "function_call",
        });
      }

      input.push(
        toolResult({
          status: "completed",
          value: {
            marker: "MCP_CODE_MODE_FILE_TOOL_RESULT",
            resultText: "fixture-note-alpha",
          },
        }),
      );
      const completed = await request();
      expect(responseText(completed)).toContain("MCP_CODE_MODE_FILE_OK note=fixture-note-alpha");

      input.push(toolResult("fixture call failed"));
      const failed = await request();
      expect(responseText(failed)).toBe(codeModeFailure);
    });
  });

  it.for([
    { output: { status: "waiting", runId: "cm_fixture" }, tools: ["exec"] },
    { output: { status: "waiting", runId: "" }, tools: ["exec", "wait"] },
    { output: { status: "waiting", runId: 42 }, tools: ["exec", "wait"] },
    {
      output: { value: { status: "waiting", runId: "nested-operation" } },
      tools: ["exec", "wait"],
    },
  ])("rejects an unusable MCP Code Mode continuation: $output", async ({ output, tools }, ctx) => {
    await withMockServer(ctx, async (baseUrl) => {
      const body = await requestResponse(
        baseUrl,
        [inputMessage("mcp code mode api file qa check"), toolResult(output)],
        {
          tools: tools.map((name) => functionTool(name)),
        },
      );
      expect(responseText(body)).toBe(codeModeFailure);
    });
  });

  it("drives the MCP App fixture tool before returning the visible marker", async (ctx) => {
    await withMockServer(ctx, async (baseUrl) => {
      const input = inputMessage("mcp app conformance qa check");
      const firstBody = await requestResponse(baseUrl, [input], {
        tools: [functionTool("fixture__show")],
      });
      expect(firstBody.output?.[0]).toMatchObject({
        arguments: "{}",
        name: "fixture__show",
        type: "function_call",
      });

      const secondBody = await requestResponse(baseUrl, [input, toolResult("initial-result")]);
      expect(responseText(secondBody)).toBe("MCP_APP_CONFORMANCE_READY");
    });
  });

  it("routes bundle discovery, activity recaps and subsequent user turns", async (ctx) => {
    await withMockServer(ctx, async (baseUrl) => {
      const runtimeContext = inputMessage(internalText("Current fixture context"));
      const input: unknown[] = [inputMessage("agent plugin bundle qa check"), runtimeContext];
      const request = async () => {
        const response = await requestResponse(baseUrl, input, {
          tools: ["tool_search", "tool_describe", "dispatch_action"].map((name) =>
            functionTool(name),
          ),
        });
        return response.output[0];
      };
      // agent-plugin-bundle-response.test.ts owns the complete discovery/receipt protocol.
      expect(await request()).toMatchObject({ type: "function_call", name: "tool_search" });
      const recap = await post(baseUrl, {
        stream: true,
        input: [
          textMessage(
            "Write an Activity recap for someone scanning their tasks: what was done here, and where it stands now.",
            "system",
          ),
          textMessage(JSON.stringify({ messages: ["user: agent plugin bundle qa check"] })),
        ],
      });
      expect(recap.status).toBe(200);
      const recapEvents = parseEvents(await recap.text());
      expect(responseBody(recapEvents, true).output).toMatchObject([
        { type: "message", content: [{ type: "output_text", text: "OPENCLAW_E2E_OK" }] },
      ]);
      input.push(inputMessage("OPENCLAW_E2E_NEXT_TURN"), runtimeContext);
      expect(await request()).toMatchObject({
        type: "message",
        content: [{ type: "output_text", text: "OPENCLAW_E2E_NEXT_TURN" }],
      });
    });
  });
});

describe("e2e mock and config helper numeric limits", () => {
  it("keeps zero invalid for other launcher port settings", () => {
    const fallback = runScript(mockOpenAiPath, { OPENCLAW_MOCK_OPENAI_PORT: "0" });
    expect(fallback.status).not.toBe(0);
    expect(fallback.stderr).toContain("invalid OPENCLAW_MOCK_OPENAI_PORT: 0");
    const webSearch = runScript(webSearchMockPath, { MOCK_PORT: "0" });
    expect(webSearch.status).not.toBe(0);
    expect(webSearch.stderr).toContain("invalid MOCK_PORT: 0");
  });

  it.for([
    { script: mockOpenAiPath, name: "mock-openai" },
    { script: webSearchMockPath, name: "mock-openai-web-search" },
  ])("reports request log failures from $name", async ({ script, name }, ctx) => {
    await withTempDir("openclaw-mock-request-log-", async (requestLogDirectory) => {
      const webSearch = script === webSearchMockPath;
      await withMockServer(
        ctx,
        async (baseUrl, stderr) => {
          const response = await post(
            baseUrl,
            webSearch
              ? {
                  input: "OPENCLAW_SCHEMA_E2E_OK",
                  reasoning: { effort: "low" },
                  tools: [{ type: "web_search" }],
                }
              : { input: "OPENCLAW_E2E_OK" },
          );
          const body = await response.json();
          expect(response.status).toBe(500);
          expect(body.error.message).toContain("mock OpenAI request log write failed");
          await expect
            .poll(stderr, { timeout: 1_000 })
            .toContain(`${name} request log write failed`);
        },
        {
          MOCK_REQUEST_LOG: requestLogDirectory,
          ...(webSearch
            ? {
                MOCK_PORT: String(await getFreePort()),
                RAW_SCHEMA_ERROR: "400 schema rejected",
                SUCCESS_MARKER: "OPENCLAW_SCHEMA_E2E_OK",
              }
            : {}),
        },
        script,
      );
    });
  });
});

async function tryBind(port: number) {
  const competitor = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      competitor.once("error", reject);
      competitor.listen(port, "127.0.0.1", resolve);
    });
    return undefined;
  } catch (error) {
    return error;
  } finally {
    if (competitor.listening) {
      await new Promise<void>((resolve, reject) => {
        competitor.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describe("SQLite flip mock endpoint ownership", () => {
  afterEach(() => vi.restoreAllMocks());

  it.for([false, true])(
    "owns the first published endpoint and handles config failure (unverified stop=%s)",
    async (unverifiedStop, { signal }) => {
      vi.mocked(spawn).mockClear();
      const envSnapshot = captureFullEnv();
      process.env.ANTHROPIC_API_KEY = "ambient-provider-fixture";
      const previousEnv = { ...process.env };
      const actualInstance = await vi.importActual<
        typeof import("../helpers/openclaw-test-instance.js")
      >("../helpers/openclaw-test-instance.js");
      const actualStop = await vi.importActual<typeof import("../helpers/stop-child-process.js")>(
        "../helpers/stop-child-process.js",
      );
      const configFailure = new Error("fixture configuration write failed");
      const stopFailure = new Error("mock process closure could not be verified");
      let instance: OpenClawTestInstance | undefined;
      let publishedPort: number | undefined;
      let mockChild: ChildProcess | undefined;
      const mockClosed = vi.fn();
      let publicationCount = 0;
      const cli = vi.fn(async (): Promise<never> => {
        throw new Error("CLI ran before configuration completed");
      });
      vi.mocked(createOpenClawTestInstance).mockImplementation(async (options) => {
        instance = await actualInstance.createOpenClawTestInstance(options);
        instance.cli = cli;
        instance.entrypoint = cli;
        const { state, homeDir, stateDir } = instance;
        const initial = JSON.parse(await readFile(instance.configPath, "utf8"));
        state.writeConfig = async (config) => {
          publicationCount++;
          expect(config).toMatchObject({
            gateway: { ...initial.gateway, mode: "local" },
            hooks: initial.hooks,
          });
          const provider = asRecord(
            asRecord(asRecord(asRecord(config)?.models)?.providers)?.openai,
          );
          if (typeof provider?.baseUrl !== "string") {
            throw new Error("mock endpoint was not configured");
          }
          publishedPort = Number(new URL(provider.baseUrl).port);
          const index = vi
            .mocked(spawn)
            .mock.calls.findIndex(([, args]) => args?.[0] === mockOpenAiPath);
          const spawned = vi.mocked(spawn).mock.results[index];
          if (spawned?.type !== "return") {
            throw new Error("mock listener was not started");
          }
          mockChild = spawned.value;
          mockChild.on("close", mockClosed);
          const childEnv = vi.mocked(spawn).mock.calls[index]?.[2]?.env;
          expect(childEnv).toMatchObject({
            HOME: homeDir,
            OPENCLAW_STATE_DIR: stateDir,
            OPENAI_API_KEY: "sk-openclaw-e2e-mock",
          });
          expect(childEnv?.ANTHROPIC_API_KEY).toBeUndefined();
          await expect(tryBind(publishedPort)).resolves.toMatchObject({ code: "EADDRINUSE" });
          const response = await fetch(`${provider.baseUrl}/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: "mock startup proof" }),
          });
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("OPENCLAW_E2E_OK_12");
          expect(await readFile(state.statePath("mock-openai-requests.ndjson"), "utf8")).toContain(
            "mock startup proof",
          );
          throw configFailure;
        };
        return instance;
      });
      vi.mocked(stopChildProcess).mockImplementation(
        unverifiedStop
          ? async () => {
              throw stopFailure;
            }
          : actualStop.stopChildProcess,
      );

      try {
        const result = await runSqliteSessionsTranscriptsFlipProof({ signal }).catch(
          (error: unknown) => error,
        );
        const mockAtSettlement = {
          closeCount: mockClosed.mock.calls.length,
          exitCode: mockChild?.exitCode,
          signalCode: mockChild?.signalCode,
        };
        expect(publicationCount).toBe(1);
        expect(cli).not.toHaveBeenCalled();
        expect(process.env).toEqual(previousEnv);
        expect(instance).toBeDefined();
        expect(mockChild).toBeDefined();
        if (unverifiedStop) {
          expect(result).toBeInstanceOf(AggregateError);
          expect((result as AggregateError).errors[0]).toBe(configFailure);
          await expect(stat(instance!.stateDir)).resolves.toBeDefined();
          expect(await tryBind(publishedPort!)).toMatchObject({ code: "EADDRINUSE" });
          expect(mockAtSettlement).toEqual({ closeCount: 0, exitCode: null, signalCode: null });
        } else {
          expect(result).toMatchObject({
            ok: false,
            failures: [expect.stringContaining(configFailure.message)],
          });
          await expect(stat(instance!.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
          // This direct Node child owns the socket; a released port may already be reused.
          expect(mockAtSettlement.closeCount).toBe(1);
          expect(mockAtSettlement.exitCode !== null || mockAtSettlement.signalCode !== null).toBe(
            true,
          );
        }
      } finally {
        for (const [child, timeout] of vi.mocked(stopChildProcess).mock.calls) {
          await actualStop.stopChildProcess(child, timeout);
        }
        await instance?.cleanup();
        vi.mocked(createOpenClawTestInstance).mockReset();
        vi.mocked(stopChildProcess).mockReset();
        vi.mocked(spawn).mockClear();
        envSnapshot.restore();
      }
    },
  );
});
