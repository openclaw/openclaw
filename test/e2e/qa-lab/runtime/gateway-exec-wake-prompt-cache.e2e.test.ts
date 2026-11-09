import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { afterEach, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import { closeHttpServer, readRequestText } from "../../../helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse as writeSse } from "../../../helpers/openai-responses-sse.js";
import { listenLoopback } from "./gateway-recovery.test-support.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL = "mock-openai/gpt-5.6-luna";
const QA_CHANNEL_ID = "qa-channel";
const RESTRICTED_GROUP_ID = "exec-wake-restricted-group";
const CONVERSATIONS = {
  // The producer of this conversation holds its session's normal tool surface.
  unrestricted: { id: "exec-wake-unrestricted", kind: "direct" as const },
  // This group's configured policy narrows every turn, so its producer is genuinely capped.
  restricted: { id: RESTRICTED_GROUP_ID, kind: "group" as const },
};
const PROMPTS = {
  unrestricted: "Exec wake cache QA check: start the fixture command, then acknowledge.",
  restricted: "Exec wake cache QA check (restricted group): start the fixture command.",
};
const EXEC_OUTPUTS = {
  unrestricted: "QA_EXEC_WAKE_UNRESTRICTED_OUTPUT",
  restricted: "QA_EXEC_WAKE_RESTRICTED_OUTPUT",
};
const PRODUCER_REPLIES = {
  unrestricted: "QA_EXEC_WAKE_PRODUCER_UNRESTRICTED_OK",
  restricted: "QA_EXEC_WAKE_PRODUCER_RESTRICTED_OK",
};
const WAKE_REPLIES = {
  unrestricted: "QA_EXEC_WAKE_UNRESTRICTED_OK",
  restricted: "QA_EXEC_WAKE_RESTRICTED_OK",
};
type Scenario = keyof typeof PROMPTS;

type RecordedRequest = {
  scenario: Scenario;
  kind: "producer" | "producer-continuation" | "wake" | "other";
  systemPrompt: string;
  toolNames: string[];
  /** The newest tool result / event text, so a missing wake names its own cause. */
  latestInputText: string;
};

let responseSequence = 0;

function responseEvents(id: string, item: Record<string, unknown>) {
  return [
    {
      type: "response.created",
      response: {
        id,
        object: "response",
        status: "in_progress",
        output: [],
        created_at: Math.floor(Date.now() / 1_000),
      },
    },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id, object: "response", status: "completed", output: [item] },
    },
  ];
}

function assistantEvents(text: string) {
  const sequence = ++responseSequence;
  return responseEvents(`resp_exec_wake_${sequence}`, {
    type: "message",
    id: `msg_exec_wake_${sequence}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
}

function execToolCallEvents(command: string) {
  const sequence = ++responseSequence;
  return responseEvents(`resp_exec_wake_tool_${sequence}`, {
    type: "function_call",
    id: `fc_exec_wake_${sequence}`,
    call_id: `call_exec_wake_${sequence}`,
    name: "exec",
    // Yield before the command finishes so the completion wakes the session on exit.
    arguments: JSON.stringify({ command, yieldMs: 250, timeoutSeconds: 60 }),
  });
}

/** The model-visible system prompt: the Responses `instructions` field plus system items. */
function readSystemPrompt(body: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof body.instructions === "string") {
    parts.push(body.instructions);
  }
  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    if (item?.role !== "system" && item?.role !== "developer") {
      continue;
    }
    const content = item.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === "string") {
          parts.push(part.text);
        }
      }
    }
  }
  return parts.join("\n");
}

function readToolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools
    .map((tool) => (typeof tool?.name === "string" ? tool.name : ""))
    .filter((name) => name.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
}

function readLatestInputText(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input.toReversed()) {
    const output = item?.output;
    if (typeof output === "string") {
      return output.slice(0, 400);
    }
    const content = item?.content;
    if (typeof content === "string") {
      return content.slice(0, 400);
    }
    if (Array.isArray(content) && typeof content[0]?.text === "string") {
      return content[0].text.slice(0, 400);
    }
  }
  return "";
}

function resolveScenario(body: Record<string, unknown>): Scenario | undefined {
  const serialized = JSON.stringify(body.input ?? []);
  for (const scenario of Object.keys(PROMPTS) as Scenario[]) {
    if (serialized.includes(PROMPTS[scenario]) || serialized.includes(EXEC_OUTPUTS[scenario])) {
      return scenario;
    }
  }
  return undefined;
}

async function startRecordingProvider() {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readRequestText(request)) as Record<string, unknown>;
      const serialized = JSON.stringify(body.input ?? []);
      const scenario = resolveScenario(body);
      const kind: RecordedRequest["kind"] = !scenario
        ? "other"
        : serialized.includes("Exec completed")
          ? "wake"
          : serialized.includes("function_call_output")
            ? "producer-continuation"
            : requests.some((entry) => entry.scenario === scenario)
              ? "other"
              : "producer";
      requests.push({
        scenario: scenario ?? "unrestricted",
        kind,
        systemPrompt: readSystemPrompt(body),
        toolNames: readToolNames(body),
        latestInputText: readLatestInputText(body),
      });
      if (scenario && kind === "producer") {
        writeSse(response, execToolCallEvents(`sleep 1 && echo ${EXEC_OUTPUTS[scenario]}`));
        return;
      }
      const text = !scenario
        ? "QA_EXEC_WAKE_UNRELATED_OK"
        : kind === "wake"
          ? WAKE_REPLIES[scenario]
          : PRODUCER_REPLIES[scenario];
      writeSse(response, assistantEvents(text));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  const baseUrl = await listenLoopback(server, "recording provider did not bind");
  return {
    baseUrl,
    requests,
    recorded: (scenario: Scenario, kind: RecordedRequest["kind"]) =>
      requests.filter((entry) => entry.scenario === scenario && entry.kind === kind),
    stop: async () => closeHttpServer(server),
  };
}

function withExecWakeConfig(config: OpenClawConfig): OpenClawConfig {
  // A plain function-tool surface keeps the exec call and the recorded prompts comparable.
  config.tools = { ...config.tools, codeMode: false, toolSearch: false };
  const channels = (config.channels ??= {}) as Record<string, Record<string, unknown>>;
  const qaChannel = (channels[QA_CHANNEL_ID] ??= {}) as Record<string, unknown>;
  qaChannel.groups = {
    ...(qaChannel.groups as Record<string, unknown> | undefined),
    // A configured group ceiling is a real narrowing: this producer's wake must stay minimal.
    // `process` keeps background exec available so the completion still wakes the session.
    [RESTRICTED_GROUP_ID]: { tools: { allow: ["read", "exec", "process", "message"] } },
  };
  return config;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

it(
  "keeps the conversation system prompt on a background exec completion wake",
  { timeout: 180_000 },
  async () => {
    const provider = await startRecordingProvider();
    cleanups.push(() => provider.stop());
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const owner = createQaGatewayChild();
    cleanups.push(async () => expect((await owner.stop()).errors).toEqual([]));
    const gateway = await owner.start({
      repoRoot: REPO_ROOT,
      useRepoCli: false,
      providerBaseUrl: `${provider.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL,
      alternateModel: MODEL,
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: withExecWakeConfig,
    });
    await transport.waitReady({ gateway });

    const failureEvidence = () =>
      JSON.stringify({
        outbound: state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .map((message) => ({
            conversation: message.conversation.id,
            deleted: message.deleted === true,
            text: message.text,
          })),
        requests: provider.requests.map((entry) => ({
          scenario: entry.scenario,
          kind: entry.kind,
          tools: entry.toolNames.length,
          systemPromptChars: entry.systemPrompt.length,
          executionBias: entry.systemPrompt.includes("## Execution Bias"),
          latestInputText: entry.latestInputText,
        })),
        // Keep the lines that explain admission of the completion, not the startup noise.
        gatewayLog: redactSensitiveText(gateway.logs().replaceAll(gateway.token, "[redacted]"), {
          mode: "tools",
        })
          .split("\n")
          .filter((line) =>
            /exec|notify|session-event|session event|admission|admitted|destination|wake|process\//i.test(
              line,
            ),
          )
          .slice(-60)
          .map((line) => line.slice(0, 300))
          .join("\n"),
      });

    /** Bounded wait on recorded provider state: the completion wake reached the model. */
    const waitForWakeRequest = async (scenario: Scenario) => {
      const deadline = Date.now() + 90_000;
      while (provider.recorded(scenario, "wake").length === 0) {
        if (Date.now() > deadline) {
          throw new Error(
            `${scenario}: no wake request reached the provider: ${failureEvidence()}`,
          );
        }
        await sleep(200);
      }
    };

    const runScenario = async (scenario: Scenario) => {
      const conversation = CONVERSATIONS[scenario];
      const sinceIndex = state
        .getSnapshot()
        .messages.filter((m) => m.direction === "outbound").length;
      await transport.sendInbound({
        accountId: "default",
        conversation,
        senderId: scenario === "restricted" ? "qa-restricted-sender" : "qa-operator",
        text: PROMPTS[scenario],
      });
      const waitOutbound = (textIncludes: string) =>
        transport
          .waitForOutbound({ conversation, sinceIndex, textIncludes, timeoutMs: 90_000 })
          .catch((error: unknown) => {
            throw new Error(
              `${scenario}: no outbound ${textIncludes}: ${error instanceof Error ? error.message : String(error)} ${failureEvidence()}`,
              { cause: error },
            );
          });
      await waitOutbound(PRODUCER_REPLIES[scenario]);
      // The command exits after the producer turn ended; its completion wakes the session.
      await waitForWakeRequest(scenario);
      return { conversation, sinceIndex, waitOutbound };
    };

    const unrestrictedTurn = await runScenario("unrestricted");
    await runScenario("restricted");
    // The woken turn is an ordinary turn: its reply reaches the conversation it woke for.
    await unrestrictedTurn.waitOutbound(WAKE_REPLIES.unrestricted);

    for (const scenario of ["unrestricted", "restricted"] as const) {
      // One producer turn and one completion wake each; anything else invalidates the comparison.
      expect(provider.recorded(scenario, "producer"), failureEvidence()).toHaveLength(1);
      expect(provider.recorded(scenario, "wake"), failureEvidence()).toHaveLength(1);
    }

    const unrestrictedProducer = provider.recorded("unrestricted", "producer")[0]!;
    const unrestrictedWake = provider.recorded("unrestricted", "wake")[0]!;
    // Byte-identical model-visible instructions are what let the provider read its cache.
    expect(unrestrictedWake.systemPrompt, failureEvidence()).toBe(
      unrestrictedProducer.systemPrompt,
    );
    expect(unrestrictedWake.systemPrompt).toContain("## Execution Bias");
    // The wake's callable surface is still the producer's ceiling, not a widened one.
    expect(unrestrictedWake.toolNames).toEqual(unrestrictedProducer.toolNames);
    expect(unrestrictedWake.toolNames).toContain("exec");

    const restrictedProducer = provider.recorded("restricted", "producer")[0]!;
    const restrictedWake = provider.recorded("restricted", "wake")[0]!;
    // Control: this producer really was capped, so its wake earns the minimal prompt while
    // the unrestricted wake above kept the conversation prompt on the same gateway.
    expect(
      restrictedProducer.toolNames.length,
      `restricted producer surface: ${JSON.stringify(restrictedProducer.toolNames)}`,
    ).toBeLessThan(unrestrictedProducer.toolNames.length);
    expect(restrictedProducer.toolNames).toContain("exec");
    expect(restrictedProducer.systemPrompt).toContain("## Execution Bias");
    expect(restrictedWake.systemPrompt).not.toContain("## Execution Bias");
    expect(restrictedWake.systemPrompt).not.toBe(restrictedProducer.systemPrompt);
    // The capped wake keeps its ceiling; provenance never widens tool access.
    expect(restrictedWake.toolNames, JSON.stringify(restrictedWake.toolNames)).toEqual(
      restrictedProducer.toolNames,
    );
  },
);
