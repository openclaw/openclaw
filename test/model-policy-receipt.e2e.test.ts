import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

let fixtureProvider: ChildProcess | undefined;
let fixtureInstance: OpenClawTestInstance | undefined;
let fixtureScratch: string | undefined;
afterEach(async () => {
  try {
    await fixtureInstance?.cleanup();
  } finally {
    try {
      if (
        fixtureProvider &&
        fixtureProvider.exitCode === null &&
        fixtureProvider.signalCode === null
      ) {
        const exited = once(fixtureProvider, "exit");
        fixtureProvider.kill("SIGTERM");
        await exited;
      }
    } finally {
      if (fixtureScratch) {
        await fs.rm(fixtureScratch, { recursive: true, force: true });
      }
      fixtureProvider = undefined;
      fixtureInstance = undefined;
      fixtureScratch = undefined;
    }
  }
});
const historySchema = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string().optional() })),
      ]),
    }),
  ),
  sessionInfo: z.object({ model: z.string(), modelOverrideSource: z.string() }),
});

it.each([
  { name: "one text block", api: "openai-completions", answer: "Receipt response." },
  { name: "two text blocks", api: "openai-responses", answer: "Receipt response.\nSecond block." },
])(
  "chat.send persists one answer and the notice receipt across restart with $name",
  async ({ api, answer }) => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-receipt-provider-"));
    fixtureScratch = scratch;
    const controlPath = path.join(scratch, "response.json");
    const texts = ["Receipt response.", "Second block."];
    const outputItems = texts.map((text, index) => ({
      type: "message",
      id: `receipt-part-${index}`,
      role: "assistant",
      phase: "final_answer",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }));
    await fs.writeFile(
      controlPath,
      JSON.stringify({
        events: [
          ...outputItems.flatMap((item, index) => [
            {
              type: "response.output_item.added",
              output_index: index,
              item: { ...item, content: [], status: "in_progress" },
            },
            {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: index,
              content_index: 0,
              delta: texts[index],
            },
            {
              type: "response.output_text.done",
              item_id: item.id,
              output_index: index,
              content_index: 0,
              text: texts[index],
            },
            { type: "response.output_item.done", output_index: index, item },
          ]),
          {
            type: "response.completed",
            response: {
              id: "receipt-response",
              status: "completed",
              output: outputItems,
              usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
            },
          },
        ],
      }),
    );
    if (api === "openai-completions") {
      await fs.writeFile(controlPath, JSON.stringify({ text: "Receipt response." }));
    }
    const provider = spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, MOCK_PORT: "0", MOCK_RESPONSE_CONTROL: controlPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    fixtureProvider = provider;
    const output = createInterface({ input: provider.stdout });
    let port: number | undefined;
    for await (const line of output) {
      const match = /^mock-openai listening on (\d+)$/u.exec(line);
      if (match) {
        port = Number(match[1]);
        break;
      }
    }
    expect(port).toBeTypeOf("number");
    const instance = await createOpenClawTestInstance({
      name: "model-policy-receipt",
      env: {
        OPENCLAW_SHELL: "exec",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_PROVIDERS: "0",
      },
      config: {
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: {
            model: "openai/fixture-primary",
            modelPolicy: { allow: ["openai/*"] },
          },
          entries: { main: {} },
        },
        models: {
          mode: "replace",
          catalogRefresh: { enabled: false },
          providers: {
            openai: {
              api,
              apiKey: "FAKE_POLICY_RECEIPT_CREDENTIAL",
              baseUrl: `http://127.0.0.1:${port}/v1`,
              agentRuntime: { id: "openclaw" },
              models: [
                { id: "fixture-primary", name: "Primary", contextWindow: 128000 },
                { id: "fixture-pin", name: "Pinned", contextWindow: 128000 },
              ],
            },
          },
        },
        plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
      },
    });
    fixtureInstance = instance;
    const call = async (method: string, params: Record<string, unknown>) => {
      const result = await instance.cli([
        "gateway",
        "call",
        method,
        "--json",
        "--params",
        JSON.stringify(params),
      ]);
      expect(result.code, `${method}: ${result.stderr}\n${result.stdout}`).toBe(0);
      const payload: unknown = JSON.parse(result.stdout);
      return payload;
    };
    const key = "agent:main:receipt";
    const expectedMessages: Array<{ role: string; text: string }> = [];
    await instance.startGateway();
    await call("sessions.create", { key, agentId: "main", model: "openai/fixture-pin" });
    await instance.stopGateway();
    const edit = await instance.cli([
      "config",
      "set",
      "agents.defaults.modelPolicy.allow",
      '["openai/fixture-primary"]',
      "--strict-json",
    ]);
    expect(edit.code, edit.stderr).toBe(0);
    await instance.startGateway();
    expect(await call("models.list", { agentId: "main" })).toMatchObject({
      models: [{ id: "fixture-primary" }],
    });

    for (const turn of [0, 1, 2]) {
      if (turn === 2) {
        await instance.stopGateway();
        await instance.startGateway();
      }
      const message = `Please answer with Receipt response. for turn ${turn}.`;
      const runId = randomUUID();
      await call("chat.send", { sessionKey: key, message, idempotencyKey: runId });
      await call("agent.wait", { runId, timeoutMs: 20_000 });
      expectedMessages.push(
        { role: "user", text: message },
        {
          role: "assistant",
          text:
            turn === 0
              ? `Pinned model openai/fixture-pin is not in your allow list. This reply used the default (openai/fixture-primary). Use /model to change it.\n\n${answer}`
              : answer,
        },
      );
      const history = historySchema.parse(
        await call("chat.history", { sessionKey: key, limit: 20 }),
      );
      expect(
        history.messages.map(({ role, content }) => ({
          role,
          text:
            typeof content === "string"
              ? content
              : content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
        })),
      ).toEqual(expectedMessages);
      expect(history.sessionInfo).toEqual({ model: "fixture-pin", modelOverrideSource: "user" });
    }
    if (api === "openai-completions") {
      const imagePath = path.join(instance.state.workspaceDir, "receipt.png");
      await fs.writeFile(
        imagePath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=",
          "base64",
        ),
      );
      await fs.writeFile(
        controlPath,
        JSON.stringify({ text: `Media follow-up.\nMEDIA:${imagePath}` }),
      );
      const runId = randomUUID();
      await call("chat.send", {
        sessionKey: key,
        message: "Please send the image.",
        idempotencyKey: runId,
      });
      await call("agent.wait", { runId, timeoutMs: 20_000 });
      const history = historySchema.parse(
        await call("chat.history", { sessionKey: key, limit: 20 }),
      );
      expect(history.messages).toHaveLength(8);
      expect(history.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: expect.arrayContaining([expect.objectContaining({ type: "image" })]),
      });
    }
  },
);
