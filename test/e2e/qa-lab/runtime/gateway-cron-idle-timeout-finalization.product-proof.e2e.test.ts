import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator } from "playwright";
import { afterEach, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import {
  FileSettingsStorage,
  type Settings,
} from "../../../../src/agents/sessions/settings-storage.js";
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
const SCREENSHOT_DIR = process.env.OPENCLAW_CRON_IDLE_TIMEOUT_FINALIZATION_SCREENSHOT_DIR?.trim();
const PROOF_LABEL = process.env.OPENCLAW_PROOF_HEAD_SHA?.trim() || "local-checkout";
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

async function captureAutomationsScreenshots(
  gateway: Pick<QaGatewayChild, "baseUrl" | "wsUrl" | "token">,
  jobId: string,
  outputDir: string,
): Promise<string[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    await fs.mkdir(outputDir, { recursive: true });
    const viewport = { width: 1440, height: 1000 };
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: outputDir, size: viewport },
      viewport,
    });
    const page = await context.newPage();
    const waitFor = (locator: Locator, timeout = 60_000) =>
      locator.waitFor({ timeout }).catch(() => undefined);
    // Native-shell auth avoids an interactive pairing prompt.
    await page.addInitScript(
      (auth) => {
        Object.assign(window, { __OPENCLAW_NATIVE_CONTROL_AUTH__: auth });
      },
      {
        gatewayUrl: gateway.wsUrl,
        token: gateway.token,
        client: {
          id: "openclaw-control-ui",
          mode: "webchat",
          platform: "linux",
          deviceFamily: "desktop",
          scopes: ["admin", "approvals", "questions", "read", "write"].map(
            (scope) => `operator.${scope}`,
          ),
        },
      },
    );
    const capture = async (name: string) => {
      const file = path.join(outputDir, `${PROOF_LABEL}-${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      written.push(file);
    };
    await page.goto(`${gateway.baseUrl}/automations?job=${encodeURIComponent(jobId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const exitSetup = page.getByRole("button", { name: /exit setup/i });
    if (await exitSetup.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await exitSetup.click();
    }
    await waitFor(page.getByText(JOB_NAME).first());
    await sleep(3_000);
    await capture("automations-job");
    // The job route opens on Settings; the run outcome lives under Run history.
    const historyTab = page.getByRole("tab", { name: /run history/i }).first();
    const historyText = page.getByText(/^Run history$/i).first();
    const history = (await historyTab.isVisible().catch(() => false)) ? historyTab : historyText;
    if (await history.isVisible().catch(() => false)) {
      await history.click().catch(() => undefined);
      await sleep(3_000);
      await waitFor(page.locator(".cron-run-entry").first(), 30_000);
      await sleep(1_000);
      await capture("automations-run-history");
    }
    // Closing the context finalizes the recording.
    const video = page.video();
    await context.close();
    const recordedPath = await video?.path();
    if (recordedPath) {
      const videoFile = path.join(outputDir, `${PROOF_LABEL}-automations.webm`);
      await fs.rename(recordedPath, videoFile);
      written.push(videoFile);
    }
  } finally {
    await browser.close();
  }
  return written;
}

it.runIf(process.env.OPENCLAW_CRON_IDLE_TIMEOUT_FINALIZATION_PROOF === "1")(
  "Gateway cron idle-timeout finalization product proof records a stalled post-tool run as failed instead of announcing the fallback summary",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const startedAt = Date.now();
    let phase = "provider";
    const heartbeat = setInterval(() => {
      console.log(
        JSON.stringify({
          phase: "proof-heartbeat",
          step: phase,
          elapsedMs: Date.now() - startedAt,
        }),
      );
    }, 20_000);
    cleanups.push(async () => clearInterval(heartbeat));
    const provider = await startControlledProvider();
    cleanups.push(() => provider.stop());
    phase = "gateway-start";
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
      controlUiEnabled: Boolean(SCREENSHOT_DIR),
      onListening: ({ runtimeEnv }) => {
        const stateDir = runtimeEnv.OPENCLAW_STATE_DIR;
        if (!stateDir) {
          throw new Error("QA gateway state directory is missing");
        }
        // Exhaust retries before exercising unanswered finalization.
        const agentDir = path.join(stateDir, "agents", "qa", "agent");
        new FileSettingsStorage(process.cwd(), agentDir).withLock("global", (raw) => {
          const settings: Settings = raw ? JSON.parse(raw) : {};
          settings.retry ??= {};
          settings.retry.provider ??= {};
          settings.retry.provider.maxRetries = PROVIDER_MAX_RETRIES;
          return JSON.stringify(settings);
        });
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

    phase = "transport-ready";
    await transport.waitReady({ gateway });
    phase = "cron";
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
    const logMark = gateway.markLogs();
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
    const { lastRunStatus, lastDeliveryStatus, lastError } = job.state ?? {};
    const gatewayLogs = gateway
      .readLogsSince(logMark)
      .split("\n")
      .filter((line) => /settled|idle timeout|fallback|cron/i.test(line))
      .map((line) => line.trim())
      .filter(Boolean);
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

    phase = "screenshots";
    const screenshots = SCREENSHOT_DIR
      ? await captureAutomationsScreenshots(gateway, added.id, SCREENSHOT_DIR)
      : [];

    const proof = {
      phase: "cron-idle-timeout-finalization-proof",
      head: process.env.OPENCLAW_PROOF_HEAD_SHA ?? process.env.GITHUB_SHA ?? "local-checkout",
      providerIdleTimeoutSeconds: PROVIDER_IDLE_TIMEOUT_SECONDS,
      providerMaxRetries: PROVIDER_MAX_RETRIES,
      cronRunTrigger: triggered,
      providerRequests: provider.requests.map((request) => ({
        seq: request.seq,
        kind: request.kind,
        ...(request.clientClosedAt !== undefined
          ? { clientClosedAfterMs: request.clientClosedAt - request.startedAt }
          : {}),
      })),
      settledWriteLanded: noteExists,
      announcedToChannel: announced,
      screenshots,
      cronRun: entry ?? null,
      jobState: { lastRunStatus, lastDeliveryStatus, lastError },
      gatewayLogs,
    };
    console.log(JSON.stringify(proof, null, 2));

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
