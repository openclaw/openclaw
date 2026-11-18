// Real isolated Gateway proof: a blind child's actual model request omits its model, identity and
// workspace, while receipts keep the real model and a non-blind sibling's prompt is unchanged.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../packages/gateway-protocol/src/client-info.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import { connectRestartClient } from "./gateway-restart.test-support.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const PLUGIN_ID = "blind-proof";
const PROVIDER = "blindproof";
const PARENT_MODEL = "parent-default-z9";
const TRIAL_MODEL = "trial-amber-x1";
const TRIAL_REF = PROVIDER + "/" + TRIAL_MODEL;
const COMMAND_SESSION = "agent:main:blind-command";
const TOOL_SESSION = "agent:main:blind-tool";
const TOOL_PARENT_PROMPT = "Start the tool trial now.";
const TASKS = {
  blind: "BLIND_NATIVE_TRIAL: reply done.",
  plain: "PLAIN_NATIVE_TRIAL: reply done.",
  tool: "BLIND_TOOL_TRIAL: reply done.",
  fork: "BLIND_FORK_TRIAL: reply done.",
} as const;
type Trial = keyof typeof TASKS;

type ModelRequest = { visible: string; tools: string[] };

// Everything the model can read: instructions, conversation input and tool schemas.
function readModelRequest(body: Record<string, unknown>): ModelRequest {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    visible: JSON.stringify({ instructions: body.instructions, input: body.input, tools }),
    tools: tools.flatMap((tool) =>
      isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
    ),
  };
}

function pluginSource() {
  return [
    "module.exports = {",
    "  id: " + JSON.stringify(PLUGIN_ID) + ",",
    "  register(api) {",
    '    const blindSupported = api.runtime.capabilities?.includes("native-subagent-blind-v1") === true;',
    "    api.registerCommand({",
    '      name: "blind-proof",',
    '      description: "Spawn one blind and one ordinary native trial",',
    "      requireAuth: true,",
    '      runtimeCapabilities: ["subagents"],',
    "      handler: async (ctx) => {",
    "        const native = ctx.runtimeContext?.subagents;",
    '        if (!native || !blindSupported) return { text: "UNAVAILABLE" };',
    "        const trial = { model: " + JSON.stringify(TRIAL_REF) + ', context: "isolated" };',
    '        const blind = await native.spawn({ ...trial, requestId: "blind", task: ' +
      JSON.stringify(TASKS.blind) +
      ", blind: true });",
    '        const plain = await native.spawn({ ...trial, requestId: "plain", task: ' +
      JSON.stringify(TASKS.plain) +
      " });",
    "        const collected = await native.collect({ ids: [blind.runId, plain.runId], awaitResults: true });",
    "        // A forked transcript would carry the requester's conversation into a blind child.",
    "        const fork = await native",
    '          .spawn({ ...trial, context: "fork", requestId: "fork", task: ' +
      JSON.stringify(TASKS.fork) +
      ", blind: true })",
    '          .then(() => "accepted", (error) => String(error?.message ?? error));',
    "        return { text: JSON.stringify({ blind, plain, collected, fork }) };",
    "      },",
    "    });",
    "  },",
    "};",
    "",
  ].join("\n");
}

it.skipIf(process.platform === "win32")(
  "omits a blind child's model, identity and workspace from its real model request",
  { timeout: 600_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-blind-proof-"));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const workspaceDir = path.join(root, "blind-proof-workspace-q7");
    await fs.mkdir(workspaceDir, { recursive: true });
    // The prompt may name either spelling (for example /tmp and /private/tmp on macOS).
    const workspaceSpellings = [...new Set([workspaceDir, await fs.realpath(workspaceDir)])];

    const trials = new Map<Trial, ModelRequest>();
    let toolParentCalls = 0;
    let toolParentRequest: ModelRequest | undefined;
    const server = await startOpenAiResponsesModelServer({
      modelId: PARENT_MODEL,
      bindError: "blind proof model fixture did not bind",
      onRequest: async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const seen = readModelRequest(body);
        const reply = (text: string) =>
          writeOpenAiResponsesText(response, {
            text,
            messageId: "msg_" + randomUUID(),
            responseId: "resp_" + randomUUID(),
          });
        if (body.stream === false) {
          // Session title generation.
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: "resp_title",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  id: "msg_title",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "Blind proof", annotations: [] }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }),
          );
          return;
        }
        const trial = (Object.keys(TASKS) as Trial[]).find((key) =>
          seen.visible.includes(TASKS[key]),
        );
        if (trial && !seen.visible.includes(TOOL_PARENT_PROMPT)) {
          trials.set(trial, seen);
          reply("done");
          return;
        }
        // The tool-session parent: spawn a blind child through the model-facing tool once.
        toolParentCalls += 1;
        if (toolParentCalls > 1) {
          reply("PARENT_DONE");
          return;
        }
        toolParentRequest = seen;
        const item = {
          type: "function_call",
          id: "fc_blind_spawn",
          call_id: "call_blind_spawn",
          name: "sessions_spawn",
          arguments: JSON.stringify({
            task: TASKS.tool,
            model: TRIAL_REF,
            blind: true,
            context: "isolated",
            expectsCompletionMessage: false,
          }),
        };
        writeOpenAiResponsesSse(response, [
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: item.id,
            delta: item.arguments,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_blind_spawn",
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
      },
    });
    onTestFinished(() => server.close());

    const pluginDir = path.join(root, "plugins", PLUGIN_ID);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: PLUGIN_ID,
        activation: { onStartup: true },
        contracts: { commandRuntimeCapabilities: ["subagents"] },
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    await fs.writeFile(path.join(pluginDir, "index.js"), pluginSource());
    const config = createOpenAiResponsesModelConfig({
      baseUrl: server.baseUrl,
      providerId: PROVIDER,
      modelId: PARENT_MODEL,
      reasoning: false,
      toolProfile: "minimal",
    });
    const provider = config.models!.providers![PROVIDER]!;
    provider.models = [
      ...provider.models,
      { ...provider.models[0]!, id: TRIAL_MODEL, name: TRIAL_MODEL },
    ];
    config.agents!.defaults!.workspace = workspaceDir;
    config.agents!.defaults!.models = {
      ...config.agents!.defaults!.models,
      [TRIAL_REF]: { agentRuntime: { id: "openclaw" } },
    };
    config.plugins = {
      allow: [PLUGIN_ID],
      load: { paths: [pluginDir] },
      entries: { [PLUGIN_ID]: { enabled: true } },
      slots: { memory: "none" },
    };
    config.tools = {
      profile: "minimal",
      alsoAllow: ["sessions_spawn", "agents_wait"],
      codeMode: false,
      toolSearch: false,
    };
    const instance = await createOpenClawTestInstance({
      name: "native-blind-proof",
      config,
      env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      startTimeoutMs: 300_000,
    });
    onTestFinished(() => instance.cleanup());

    try {
      await instance.startGateway();
      const events: Array<{ event?: string; payload?: unknown }> = [];
      const client = await connectRestartClient(instance, {
        clientName: GATEWAY_CLIENT_IDS.TUI,
        mode: GATEWAY_CLIENT_MODES.UI,
        onEvent: (event) => events.push(event),
      });
      try {
        // Native plugin spawn: one blind and one ordinary child, same model and task shape.
        await client.request("sessions.create", { key: COMMAND_SESSION, agentId: "main" });
        const runId = randomUUID();
        await client.request("chat.send", {
          sessionKey: COMMAND_SESSION,
          message: "/blind-proof",
          deliver: false,
          idempotencyKey: runId,
        });
        let commandText: string | undefined;
        await vi.waitFor(
          () => {
            const final = events.find((event) => {
              const payload = event.payload as { runId?: string; state?: string } | undefined;
              return (
                event.event === "chat" && payload?.runId === runId && payload.state === "final"
              );
            });
            commandText = extractFirstTextBlock((final?.payload as { message?: unknown })?.message);
            expect(commandText, instance.logs()).toMatch(/^\{/u);
          },
          { timeout: 180_000, interval: 100 },
        );
        const proof = JSON.parse(commandText!) as {
          blind: { runId: string; childSessionKey: string; selection?: unknown };
          plain: { runId: string; childSessionKey: string; selection?: unknown };
          collected: { completed: Array<{ runId: string; status: string; selection?: unknown }> };
          fork: string;
        };
        expect(proof.fork).toContain('Blind spawns require context="isolated"');

        // Model-facing tool: the parent model asks sessions_spawn for a blind child.
        await client.request(
          "agent",
          {
            sessionKey: TOOL_SESSION,
            message: TOOL_PARENT_PROMPT,
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { expectFinal: true, timeoutMs: 120_000 },
        );
        await vi.waitFor(() => expect(trials.has("tool"), instance.logs()).toBe(true), {
          timeout: 120_000,
          interval: 100,
        });

        expect(trials.has("fork")).toBe(false);
        const blind = trials.get("blind")!;
        const plain = trials.get("plain")!;
        const tool = trials.get("tool")!;
        expect(blind).toBeDefined();
        expect(plain).toBeDefined();
        const rows = await client.request<SessionsListResult>("sessions.list", { agentId: "main" });
        const toolChild = rows.sessions.find(
          (row) =>
            row.key.includes(":subagent:") &&
            row.key !== proof.blind.childSessionKey &&
            row.key !== proof.plain.childSessionKey,
        );
        expect(toolChild).toBeDefined();

        // The ordinary child still sees every fact the blind children must not.
        expect(plain.visible).toContain("Current model identity: " + TRIAL_REF);
        expect(plain.visible).toContain("default_model=" + PROVIDER + "/" + PARENT_MODEL);
        expect(plain.visible).toContain("session=" + proof.plain.childSessionKey);
        expect(plain.visible).toContain("agent=main");
        expect(plain.visible).toContain("Your session: " + proof.plain.childSessionKey);
        expect(workspaceSpellings.some((spelling) => plain.visible.includes(spelling))).toBe(true);

        for (const [request, childKey] of [
          [blind, proof.blind.childSessionKey],
          [tool, toolChild!.key],
        ] as const) {
          expect(request.visible).toContain(request === blind ? TASKS.blind : TASKS.tool);
          for (const withheld of [
            TRIAL_MODEL,
            PARENT_MODEL,
            "Current model identity",
            "agent=main",
            childKey,
            COMMAND_SESSION,
            TOOL_SESSION,
            "Your session:",
            ...workspaceSpellings,
          ]) {
            expect(request.visible, withheld).not.toContain(withheld);
          }
          expect(request.visible).toContain("Working directory: <workspace>");
          // Blinding changes prompt text only: the child keeps the same tool surface.
          expect(request.tools).toEqual(plain.tools);
        }
        // The parent model is offered the opt-in on the ordinary tool schema.
        expect(toolParentRequest?.visible).toContain("Blind trial");

        // Receipts and the parent's session view keep the real route.
        for (const accepted of [proof.blind, proof.plain]) {
          expect(accepted.selection).toMatchObject({
            requested: { model: TRIAL_REF },
            resolved: { model: TRIAL_REF },
          });
        }
        expect(proof.collected.completed).toHaveLength(2);
        for (const completed of proof.collected.completed) {
          expect(completed).toMatchObject({
            status: "done",
            selection: { resolved: { model: TRIAL_REF } },
          });
        }
        for (const key of [proof.blind.childSessionKey, toolChild!.key]) {
          expect(rows.sessions.find((row) => row.key === key)).toMatchObject({
            model: TRIAL_MODEL,
            modelProvider: PROVIDER,
          });
        }
      } finally {
        await client.stopAndWait();
      }
    } catch (error) {
      throw new Error(String(error) + "\n" + instance.logs(), { cause: error });
    }
  },
);
