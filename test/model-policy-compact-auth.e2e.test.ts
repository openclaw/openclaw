// Exercises /compact auth selection through a real Gateway chat.send and a recording provider.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { writeOpenAiResponsesSse } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

let instance: OpenClawTestInstance | undefined;
let provider: Server | undefined;
afterEach(async () => {
  try {
    await instance?.cleanup();
  } finally {
    instance = undefined;
    const server = provider;
    provider = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

const chatEventSchema = z.object({
  runId: z.string(),
  state: z.string(),
  message: z.unknown().optional(),
  errorMessage: z.string().optional(),
});
const historySchema = z.object({
  sessionInfo: z.object({ model: z.string(), modelOverrideSource: z.string().nullable() }),
});

it.each([
  { name: "missing cross-provider primary", authoredPrimary: "anthropic/missing@anthropic:work" },
  {
    name: "available explicitly pinned primary",
    authoredPrimary: "openai/fixture-primary@openai:work",
  },
])(
  "chat.send /compact uses effective-default auth with $name",
  { timeout: 180_000 },
  async ({ authoredPrimary }) => {
    const requests: Array<{ model: string; authorization: string | undefined }> = [];
    let answer = (
      "Retain release decision RELEASE-144780 and validation record VERIFY-144780 " +
      "in /workspace/release-plan.md. "
    ).repeat(1_000);
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "fixture-primary" }, { id: "fixture-pin" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = z
          .object({ model: z.string() })
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        requests.push({ model: body.model, authorization: request.headers.authorization });
        writeOpenAiResponsesSse(response, [
          {
            id: "compact-auth-response",
            object: "chat.completion.chunk",
            model: body.model,
            choices: [
              { index: 0, delta: { role: "assistant", content: answer }, finish_reason: null },
            ],
          },
          {
            id: "compact-auth-response",
            object: "chat.completion.chunk",
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          },
        ]);
      });
    });
    provider = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Recording provider did not bind");
    }
    const runtime = await createOpenClawTestInstance({
      name: "model-policy-compact-auth",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0", OPENCLAW_SKIP_PROVIDERS: "0" },
      config: {
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: {
            model: "openai/fixture-primary",
            modelPolicy: { allow: ["openai/*"] },
            compaction: { enabled: false, keepRecentTokens: 1_024, recentTurnsPreserve: 1 },
          },
        },
        models: {
          mode: "replace",
          catalogRefresh: { enabled: false },
          providers: {
            openai: {
              api: "openai-completions",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              request: { allowPrivateNetwork: true },
              agentRuntime: { id: "openclaw" },
              models: [
                { id: "fixture-primary", name: "Primary", contextWindow: 128_000 },
                { id: "fixture-pin", name: "Pinned", contextWindow: 128_000 },
              ],
            },
          },
        },
        plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
      },
    });
    instance = runtime;
    await runtime.state.writeAuthProfiles({
      version: 1,
      profiles: {
        "openai:work": { type: "api_key", provider: "openai", key: "FAKE_OPENAI_WORK" },
        "anthropic:work": { type: "api_key", provider: "anthropic", key: "FAKE_ANTHROPIC_WORK" },
      },
    });
    await runtime.startGateway();
    const sessionKey = "agent:main:compact-auth";
    const events = new Map<string, z.infer<typeof chatEventSchema>>();
    const connect = () =>
      connectGatewayClient({
        url: runtime.url,
        token: runtime.gatewayToken,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => {
          if (event.event === "chat") {
            const parsed = chatEventSchema.parse(event.payload);
            events.set(parsed.runId, parsed);
          }
        },
      });
    let client = await connect();
    const send = async (message: string) => {
      const runId = randomUUID();
      await client.request("chat.send", { sessionKey, message, idempotencyKey: runId });
      await expect
        .poll(
          () => {
            const state = events.get(runId)?.state;
            return state === "final" || state === "error";
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const event = events.get(runId);
      expect(event, JSON.stringify({ event, requests })).toMatchObject({ state: "final" });
      return event;
    };
    try {
      await client.request("sessions.create", {
        key: sessionKey,
        agentId: "main",
        model: "openai/fixture-pin",
      });
      for (const index of [0, 1, 2]) {
        await send(
          `Record release decision ${index} for RELEASE-144780 with validation VERIFY-144780.`,
        );
      }
      expect(requests).toHaveLength(3);
      expect(requests.every((request) => request.model === "fixture-pin")).toBe(true);
      await disconnectGatewayClient(client);
      await runtime.stopGateway();
      const record = z.record(z.string(), z.unknown());
      const authoredConfig = record.parse(
        JSON.parse(await fs.readFile(runtime.configPath, "utf8")),
      );
      const agents = record.parse(authoredConfig.agents);
      const defaults = record.parse(agents.defaults);
      defaults.model = authoredPrimary;
      defaults.modelPolicy = { allow: ["openai/fixture-primary"] };
      agents.defaults = defaults;
      authoredConfig.agents = agents;
      await fs.writeFile(runtime.configPath, `${JSON.stringify(authoredConfig, null, 2)}\n`);
      const validated = await runtime.cli(["config", "validate", "--json"]);
      expect(validated.code, `${validated.stderr}\n${validated.stdout}`).toBe(0);
      await runtime.startGateway();
      client = await connect();
      answer = [
        "## Decisions",
        "Recorded release decisions 0, 1, and 2 for RELEASE-144780 with validation VERIFY-144780.",
        "Retain the release decision and its completed validation in /workspace/release-plan.md.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Preserve the release decision, validation record, and exact plan path.",
        "## Pending user asks",
        "None.",
        "## Exact identifiers",
        "RELEASE-144780",
        "VERIFY-144780",
        "/workspace/release-plan.md",
      ].join("\n");
      const beforeCompact = requests.length;
      const result = await send("/compact");
      const compactionRequests = requests.slice(beforeCompact);
      console.log(
        JSON.stringify({
          proof: "compact-effective-default-auth",
          authoredPrimary,
          compactionRequests,
          result,
        }),
      );
      expect(JSON.stringify(result?.message)).toContain("Compacted");
      expect(compactionRequests.length).toBeGreaterThan(0);
      expect(compactionRequests).toEqual(
        compactionRequests.map(() => ({
          model: "fixture-primary",
          authorization: "Bearer FAKE_OPENAI_WORK",
        })),
      );
      const history = historySchema.parse(
        await client.request("chat.history", { sessionKey, limit: 20 }),
      );
      expect(history.sessionInfo).toEqual({ model: "fixture-pin", modelOverrideSource: "user" });
    } finally {
      await disconnectGatewayClient(client);
    }
  },
);
