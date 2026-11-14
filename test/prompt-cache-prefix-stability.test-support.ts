// One Gateway session through every mid-session trigger: each provider request must extend the
// previous one byte for byte, except at a compaction (explicit, or the provider's own).
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { waitForGatewayActiveWork } from "../src/infra/gateway-active-work.js";
import { listenProofProvider, useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const TOKEN = "prefix-stability-token";
const TARGET = "agent:main:prefix-stability-target";
const SENDER = "agent:main:prefix-stability-sender";

export type Api = "anthropic-messages" | "openai-completions" | "openai-responses";
type Reply = { text: string; compaction?: true } | { tool: string; args: Record<string, unknown> };
type WireRequest = { system: string; tools: string; messages: string[]; text: string };

// Cache markers move to the newest message on every request, and the newest message carries
// its text as a block so it can hold one. Providers cache the processed prompt, where a string
// and a single text block are the same content, so neither difference is a prefix change.
function withoutCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutCacheMarkers);
  }
  if (value && typeof value === "object") {
    const content = (value as { content?: unknown }).content;
    if (typeof content === "string" && "role" in value) {
      return withoutCacheMarkers({ ...value, content: [{ type: "text", text: content }] });
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, entry]) => [key, withoutCacheMarkers(entry)]),
    );
  }
  return value;
}

function readWireRequest(api: Api, body: Record<string, unknown>): WireRequest {
  if (api === "openai-responses") {
    const system = JSON.stringify(body.instructions ?? null);
    const messages = ((body.input as unknown[] | undefined) ?? []).map((item) =>
      JSON.stringify(item),
    );
    return {
      system,
      tools: JSON.stringify(body.tools ?? []),
      messages,
      text: `${system}\n${messages.join("\n")}`,
    };
  }
  const all = (body.messages as Array<{ role?: unknown }> | undefined) ?? [];
  // Chat Completions sends the system prompt as leading system messages.
  const lead =
    api === "openai-completions"
      ? all.findIndex(({ role }) => role !== "system" && role !== "developer")
      : 0;
  const json = (value: unknown) => JSON.stringify(withoutCacheMarkers(value));
  const system = json(api === "openai-completions" ? all.slice(0, lead) : body.system);
  const messages = all.slice(lead).map(json);
  return {
    system,
    tools: json(body.tools ?? []),
    messages,
    text: `${system}\n${messages.join("\n")}`,
  };
}

/** Messages after the newest assistant reply: the current input, carriers and tool results. */
function lastMessage(request: WireRequest): string {
  const assistant = request.messages.findLastIndex((message) =>
    /"role":"assistant"|"type":"(function_call|compaction)"/.test(message),
  );
  return request.messages.slice(assistant + 1).join("\n");
}

function writeReply(api: Api, response: ServerResponse, reply: Reply, ordinal: number) {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  if (api === "anthropic-messages") {
    const block =
      "text" in reply
        ? { type: "text", text: "" }
        : { type: "tool_use", id: `toolu_${ordinal}`, name: reply.tool, input: {} };
    const delta =
      "text" in reply
        ? { type: "text_delta", text: reply.text }
        : { type: "input_json_delta", partial_json: JSON.stringify(reply.args) };
    const events = [
      {
        type: "message_start",
        message: {
          id: `msg_${ordinal}`,
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_delta", index: 0, delta },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "text" in reply ? "end_turn" : "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
    response.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    return;
  }
  if (api === "openai-responses") {
    const items = [
      // The provider compacts the request it received and returns the checkpoint first.
      ...("compaction" in reply && reply.compaction
        ? [{ type: "compaction", id: `cmp_${ordinal}`, encrypted_content: `checkpoint-${ordinal}` }]
        : []),
      "text" in reply
        ? {
            type: "message",
            id: `msg_${ordinal}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: reply.text, annotations: [] }],
          }
        : {
            type: "function_call",
            id: `fc_${ordinal}`,
            call_id: `call_${ordinal}`,
            name: reply.tool,
            arguments: JSON.stringify(reply.args),
            status: "completed",
          },
    ];
    const events = [
      ...items.flatMap((item, index) => [
        { type: "response.output_item.added", output_index: index, item },
        { type: "response.output_item.done", output_index: index, item },
      ]),
      {
        type: "response.completed",
        response: {
          id: `resp_${ordinal}`,
          object: "response",
          status: "completed",
          model: "gpt-5.4",
          output: items,
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 5,
            total_tokens: 15,
          },
        },
      },
    ];
    response.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    return;
  }
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: `chatcmpl_${ordinal}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-5.4-mini",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
    })}\n\n`;
  const delta =
    "text" in reply
      ? { role: "assistant", content: reply.text }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${ordinal}`,
              type: "function",
              function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
            },
          ],
        };
  response.end(
    `${chunk(delta, null)}${chunk({}, "text" in reply ? "stop" : "tool_calls")}data: [DONE]\n\n`,
  );
}

function buildProvider(api: Api, baseUrl: string) {
  const routes: Record<Api, readonly [providerId: string, id: string]> = {
    "anthropic-messages": ["fake-anthropic", "claude-opus-5"],
    "openai-completions": ["fake-completions", "gpt-5.4-mini"],
    "openai-responses": ["fake-responses", "gpt-5.4"],
  };
  const [providerId, id] = routes[api];
  const model: ModelDefinitionConfig = {
    id,
    name: `Fake ${id}`,
    api,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  const config: ModelProviderConfig = {
    baseUrl: api === "anthropic-messages" ? baseUrl : `${baseUrl}/v1`,
    apiKey: "prefix-stability-key", // pragma: allowlist secret
    api,
    // The fake provider listens on loopback.
    request: { allowPrivateNetwork: true },
    models: [model],
  };
  return { providerId, modelRef: `${providerId}/${id}`, config } as const;
}

/** Requests that do not extend the previous request in the same session, with the first change. */
function prefixBreaks(requests: readonly WireRequest[]): Array<{ at: number; change: string }> {
  const breaks: Array<{ at: number; change: string }> = [];
  for (let index = 1; index < requests.length; index++) {
    const previous = requests[index - 1]!;
    const current = requests[index]!;
    const message = previous.messages.findIndex(
      (entry, position) => current.messages[position] !== entry,
    );
    const change =
      previous.system !== current.system
        ? "system"
        : previous.tools !== current.tools
          ? "tools"
          : message >= 0
            ? `message ${message}: ${previous.messages[message]!.slice(0, 160)} -> ${(current.messages[message] ?? "(removed)").slice(0, 160)}`
            : undefined;
    if (change) {
      breaks.push({ at: index, change });
    }
  }
  return breaks;
}

/** One Gateway process per route: gateway state is process-wide, so each route has its own file. */
export function usePrefixStabilityJourney() {
  const createFixture = useRuntimeProofFixture(afterEach);
  // The wire check below reports every break; the in-process assertion would stop at the first.
  let assertSetting: string | undefined;
  beforeEach(() => {
    assertSetting = process.env.OPENCLAW_PROMPT_CACHE_ASSERT;
    process.env.OPENCLAW_PROMPT_CACHE_ASSERT = "0";
  });
  afterEach(() => {
    process.env.OPENCLAW_PROMPT_CACHE_ASSERT = assertSetting;
  });
  return async (api: Api) => {
    const fixture = await createFixture(`openclaw-prefix-stability-${api}-`, TOKEN, "1");
    const targetRequests: WireRequest[] = [];
    const seen: string[] = [];
    let ordinal = 0;
    const script = (request: WireRequest): Reply => {
      const latest = lastMessage(request);
      const hasToolResult = /tool_result|"role":"tool"|function_call_output/.test(latest);
      if (request.tools === "[]") {
        return { text: "Summary: the session ran the probe journey." };
      }
      if (request.text.includes(`session=${SENDER}`)) {
        return hasToolResult || !latest.includes("forward a ping")
          ? { text: "REPLY_SKIP" }
          : {
              tool: "sessions_send",
              args: { sessionKey: TARGET, message: "INTER-SESSION ping", timeoutSeconds: 0 },
            };
      }
      if (!request.text.includes(`session=${TARGET}`)) {
        return { text: "child-done" };
      }
      targetRequests.push(request);
      if (hasToolResult) {
        return { text: "acknowledged" };
      }
      if (latest.includes("STEP-EXEC")) {
        return {
          tool: "exec",
          args: { command: "sleep 1; echo exec-finished", background: true },
        };
      }
      if (latest.includes("STEP-PROVIDER-COMPACT")) {
        return { text: `ok ${targetRequests.length}`, compaction: true };
      }
      if (latest.includes("STEP-SPAWN")) {
        return {
          tool: "sessions_spawn",
          args: { task: "CHILD-TASK reply child-done", expectsCompletionMessage: true },
        };
      }
      return { text: `ok ${targetRequests.length}` };
    };
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const wire = readWireRequest(api, JSON.parse(body) as Record<string, unknown>);
        const reply = script(wire);
        const session = /session=(\S+)/.exec(wire.text)?.[1] ?? "?";
        seen.push(`${session} last=${lastMessage(wire).slice(-300)} -> ${JSON.stringify(reply)}`);
        writeReply(api, response, reply, ++ordinal);
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const provider = buildProvider(api, await listenProofProvider(server));
      await fs.writeFile(path.join(fixture.workspaceDir, "AGENTS.md"), "# Rules\n- Be brief.\n");
      const cfg = fixture.config(
        provider,
        {
          compaction: {
            mode: "default",
            keepRecentTokens: 1,
            recentTurnsPreserve: 0,
            memoryFlush: { enabled: false },
          },
        },
        {
          diagnostics: { cacheTrace: { enabled: true } },
          plugins: { enabled: false },
          tools: {
            codeMode: { enabled: false },
            toolSearch: false,
            exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: true },
          },
        },
      );
      gateway = await startGatewayWithClient({
        cfg,
        configPath: fixture.configPath,
        token: TOKEN,
        clientDisplayName: "prefix-stability",
      });
      const client = gateway.client;
      // Background work (exec wakes, child completions) settles once requests stop arriving.
      const settle = async () => {
        await waitForGatewayActiveWork(20_000);
        let count = -1;
        for (let rounds = 0; count !== seen.length && rounds < 20; rounds++) {
          count = seen.length;
          await new Promise((resolve) => {
            setTimeout(resolve, 1_500);
          });
        }
      };
      const send = async (sessionKey: string, message: string) => {
        const started = await client.request<{ runId?: string }>("chat.send", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: `prefix-stability-${api}-${++ordinal}`,
        });
        const waited = await client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        seen.push(
          `send ${sessionKey} ${message}: ${JSON.stringify(started)} ${JSON.stringify(waited)}`,
        );
        await settle();
      };
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 60_000;
        while (!predicate()) {
          expect(Date.now(), seen.join("\n")).toBeLessThan(deadline);
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
        }
        await settle();
      };

      try {
        await send(TARGET, "TARGET first user turn");
        // Exec completion wakes the session with a host system turn.
        await send(TARGET, "STEP-EXEC run the probe in the background");
        await until(() => targetRequests.some((r) => lastMessage(r).includes("exec-finished")));
        // A subagent settles back into the session.
        await send(TARGET, "STEP-SPAWN start a child");
        await until(() => targetRequests.some((r) => lastMessage(r).includes("child-done")));
        // Inter-session input from another session.
        await send(SENDER, "forward a ping to the target");
        await until(() => targetRequests.some((r) => lastMessage(r).includes("INTER-SESSION")));
        // A skill appears and a workspace bootstrap file changes mid-session.
        const skillDir = path.join(fixture.workspaceDir, "skills", "probe-skill");
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          "---\nname: probe-skill\ndescription: Probe skill added mid-session.\n---\n\nReply probe.\n",
        );
        await send(TARGET, "TARGET after skill");
        await fs.appendFile(path.join(fixture.workspaceDir, "AGENTS.md"), "- Prefer bullets.\n");
        await send(TARGET, "TARGET after workspace edit");
        // The provider compacts on its own (Responses server-side compaction): its checkpoint
        // replaces the history it summarized from the next request on, an allowed rebuild point.
        const providerCompactionAt =
          api === "openai-responses"
            ? await (async () => {
                await send(TARGET, "STEP-PROVIDER-COMPACT continue");
                const at = targetRequests.length;
                await send(TARGET, "TARGET after provider compaction");
                return at;
              })()
            : undefined;
        // Explicit compaction is the one allowed rebuild point in this journey.
        await client.request("sessions.compact", { key: TARGET }, { timeoutMs: 65_000 });
        await settle();
        const compactionAt = targetRequests.length;
        await send(TARGET, "TARGET after compaction");
        expect(targetRequests.length).toBeGreaterThan(compactionAt);
        const breaks = prefixBreaks(targetRequests);
        expect(
          breaks.map(({ at }) => at),
          JSON.stringify(breaks, null, 2),
        ).toEqual(
          providerCompactionAt === undefined
            ? [compactionAt]
            : [providerCompactionAt, compactionAt],
        );
        if (providerCompactionAt !== undefined) {
          // The cache observer attributes the provider checkpoint to compaction, not to drift.
          const trace = await fs.readFile(
            path.join(fixture.stateDir, "logs", "cache-trace.jsonl"),
            "utf8",
          );
          const attributed = trace
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  stage?: string;
                  sessionKey?: string;
                  options?: { changes?: Array<{ detail?: string }> | null };
                },
            )
            .filter(
              (event) =>
                event.stage === "cache:result" &&
                event.sessionKey === TARGET &&
                event.options?.changes?.some(
                  ({ detail }) =>
                    detail === "provider compaction checkpoint replaced earlier history",
                ),
            );
          expect(attributed).toHaveLength(1);
        }
      } catch (error) {
        throw new Error(`${String(error)}\n${seen.join("\n")}`, { cause: error });
      }
    } finally {
      await fixture.close(gateway, server, true);
    }
  };
}
