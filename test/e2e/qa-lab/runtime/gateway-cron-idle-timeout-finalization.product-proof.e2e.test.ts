import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import type { Settings } from "../../../../src/agents/sessions/settings-storage.js";
import { startOpenAiResponsesModelServer } from "../../../helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

// #141032: empty summary recovery must not turn a post-tool idle timeout into success.
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const PROMPT = "Write proof-note.txt with the word settled, then report what you did.";
const NOTE_FILE = "proof-note.txt";
const JOB_NAME = "idle-timeout-finalization-proof";
const ANNOUNCE_CONVERSATION = { id: "idle-timeout-proof-announce", kind: "direct" as const };
const PROVIDER_IDLE_TIMEOUT_SECONDS = 8;
const PROVIDER_MAX_RETRIES = 0;
const RUN_WAIT_MS = 100_000;
// Source-mode Gateway startup with packaged plugins can take a few minutes on slow hosts.
const TEST_TIMEOUT_MS = RUN_WAIT_MS + 500_000;
const SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT =
  "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";
const GATEWAY_ENTRY = process.env.OPENCLAW_CRON_IDLE_TIMEOUT_FINALIZATION_GATEWAY_ENTRY?.trim();

type ProviderRequest = {
  seq: number;
  kind: "tool-call" | "stalled" | "finalization";
  startedAt: number;
  clientClosedAt?: number;
};

type CronRunEntry = Partial<Record<"status" | "completionStatus" | "error", unknown>>;

const cleanups: Array<() => Promise<void>> = [];

afterEach(() => runQaGatewayFixture(async () => undefined, ...cleanups.splice(0).toReversed()));

function writeProviderReply(response: ServerResponse, seq: number, empty = false): void {
  const args = JSON.stringify({ path: NOTE_FILE, content: "settled" });
  const call = {
    type: "function_call",
    id: `fc_idle_timeout_proof_${seq}`,
    call_id: `call_idle_timeout_proof_${seq}`,
    name: "write",
    arguments: args,
  };
  // Summary recovery answers with a completed message that carries no text.
  const message = {
    type: "message",
    id: `msg_idle_timeout_proof_empty_${seq}`,
    role: "assistant",
    status: "completed",
    content: [],
  };
  const item = empty ? message : call;
  const event = (type: string, fields: Record<string, unknown>) => ({
    type: `response.${type}`,
    output_index: 0,
    ...fields,
  });
  const input_tokens = empty ? 8 : 32;
  const output_tokens = empty ? 0 : 12;
  writeOpenAiResponsesSse(response, [
    event("output_item.added", {
      item: empty ? { ...message, status: "in_progress" } : { ...call, arguments: "" },
    }),
    ...(empty
      ? []
      : [
          event("function_call_arguments.delta", { item_id: call.id, delta: args }),
          event("function_call_arguments.done", {
            item_id: call.id,
            name: call.name,
            arguments: args,
          }),
        ]),
    event("output_item.done", { item }),
    {
      type: "response.completed",
      response: {
        id: `resp_idle_timeout_proof_${empty ? "empty_" : ""}${seq}`,
        status: "completed",
        output: [item],
        usage: { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens },
      },
    },
  ]);
}

async function startControlledProvider() {
  const requests: ProviderRequest[] = [];
  const { baseUrl, close: stop } = await startOpenAiResponsesModelServer({
    modelId: "gpt-5.6-luna",
    bindError: "controlled provider did not bind a loopback port",
    onRequest: async (request, response) => {
      const body = (await json(request)) as {
        tools?: unknown[];
        input?: unknown;
      };
      const toolsOffered = Array.isArray(body.tools) && body.tools.length > 0;
      const inputText = JSON.stringify(body.input ?? []);
      const entry: ProviderRequest = {
        seq: requests.length + 1,
        kind: !toolsOffered
          ? "finalization"
          : !inputText.includes("function_call_output")
            ? "tool-call"
            : "stalled",
        startedAt: Date.now(),
      };
      requests.push(entry);
      if (entry.kind !== "stalled") {
        writeProviderReply(response, entry.seq, entry.kind === "finalization");
        return;
      }
      // Leaving the response open stalls until the Gateway's watchdog aborts it;
      // stop() closes any connection still waiting during fixture cleanup.
      response.once("close", () => {
        entry.clientClosedAt ??= Date.now();
      });
    },
  });
  return { baseUrl, requests, stop };
}

it.runIf(process.env.OPENCLAW_CRON_IDLE_TIMEOUT_FINALIZATION_PROOF === "1")(
  "Gateway cron idle-timeout finalization product proof records a stalled post-tool run as failed instead of announcing the fallback summary",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const provider = await startControlledProvider();
    cleanups.push(() => provider.stop());
    const busState = createQaBusState();
    const transport = createQaChannelTransport(busState);
    const bus = await startQaBusServer({ state: busState });
    cleanups.push(() => bus.stop());
    const gatewayOwner = createQaGatewayChild();
    cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
    const gateway = await gatewayOwner.start({
      repoRoot: process.cwd(),
      command: {
        executablePath: process.execPath,
        argsPrefix: GATEWAY_ENTRY ? [GATEWAY_ENTRY] : ["--import", "tsx", "src/entry.ts"],
        cwd: process.cwd(),
        usePackagedPlugins: true,
      },
      providerBaseUrl: `${provider.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      onListening: ({ runtimeEnv }) => {
        const stateDir = runtimeEnv.OPENCLAW_STATE_DIR;
        if (!stateDir) {
          throw new Error("QA gateway state directory is missing");
        }
        // Exhaust retries before exercising unanswered finalization.
        const agentDir = path.join(stateDir, "agents", "qa", "agent");
        const settingsPath = path.join(agentDir, "settings.json");
        const settings: Settings = existsSync(settingsPath)
          ? JSON.parse(readFileSync(settingsPath, "utf-8"))
          : {};
        settings.retry ??= {};
        settings.retry.provider ??= {};
        settings.retry.provider.maxRetries = PROVIDER_MAX_RETRIES;
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings));
      },
      mutateConfig: (config) => {
        const providerConfig = config.models?.providers?.["mock-openai"];
        if (!providerConfig) {
          throw new Error("mock-openai provider is missing from QA gateway config");
        }
        const providers = {
          ...config.models?.providers,
          "mock-openai": { ...providerConfig, timeoutSeconds: PROVIDER_IDLE_TIMEOUT_SECONDS },
        };
        return { ...config, models: { ...config.models, providers } };
      },
    });

    await transport.waitReady({ gateway });
    const added = (await gateway.call(
      "cron.add",
      {
        name: JOB_NAME,
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: PROMPT,
          timeoutSeconds: 120,
        },
        delivery: { mode: "announce", channel: "qa-channel", to: ANNOUNCE_CONVERSATION.id },
      },
      { timeoutMs: 30_000 },
    )) as { id: string };
    expect(typeof added.id).toBe("string");

    const outboundBefore = busState
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    const triggered = (await gateway.call(
      "cron.run",
      { id: added.id, mode: "force" },
      { timeoutMs: 30_000 },
    )) as { ok?: unknown; ran?: unknown; enqueued?: unknown };
    expect(triggered).toMatchObject({ ok: true });
    expect(triggered.ran === true || triggered.enqueued === true).toBe(true);

    const deadline = Date.now() + RUN_WAIT_MS;
    let entry: CronRunEntry | undefined;
    while (Date.now() < deadline) {
      const page = (await gateway.call(
        "cron.runs",
        { id: added.id, limit: 5 },
        { timeoutMs: 10_000 },
      )) as { entries?: CronRunEntry[] };
      entry = (page.entries ?? []).find((candidate) => candidate.status !== undefined);
      if (entry) {
        break;
      }
      await sleep(500);
    }
    const job = (await gateway.call("cron.get", { id: added.id }, { timeoutMs: 10_000 })) as {
      state?: Record<string, unknown>;
    };
    const { lastRunStatus } = job.state ?? {};
    const noteExists = await fs
      .access(path.join(gateway.workspaceDir, NOTE_FILE))
      .then(() => true)
      .catch(() => false);
    const stalled = provider.requests.find((request) => request.kind === "stalled");
    // Give the announce path a moment to settle after the run record lands.
    await sleep(2_000);
    const announced = busState
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound")
      .slice(outboundBefore)
      .map((message) => ({ conversation: message.conversation, text: message.text }));

    expect(entry, "cron run never finished").toBeDefined();
    expect(noteExists).toBe(true);
    expect(provider.requests.map((request) => request.kind)).toEqual([
      "tool-call",
      "stalled",
      "finalization",
      "finalization",
    ]);
    expect(stalled?.clientClosedAt).toBeDefined();
    expect((stalled?.clientClosedAt ?? 0) - (stalled?.startedAt ?? 0)).toBeGreaterThanOrEqual(
      PROVIDER_IDLE_TIMEOUT_SECONDS * 1_000 - 500,
    );

    expect(JSON.stringify(entry)).not.toContain(SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT);
    expect(JSON.stringify(announced)).not.toContain(SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT);
    expect(entry).toMatchObject({ status: "error" });
    expect(entry?.completionStatus).not.toBe("succeeded");
    expect(typeof entry?.error === "string" ? entry.error : "").toMatch(/idle timeout/i);
    expect(lastRunStatus).toBe("error");
  },
);
