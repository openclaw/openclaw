import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../helpers/fixture-receipts.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  closeNativeProvider,
  createNativeProvider,
  listenNativeProvider,
} from "./native-provider-proof-fixture.js";

// #143381: each isolated heartbeat leaked its fresh session's MCP stdio child.
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const RESPONSE_TEXT = "HEARTBEAT_OK";
const HEARTBEAT_RUNS = 3;
const TEST_TIMEOUT_MS = 600_000;
const VARIANT =
  process.env.OPENCLAW_HEARTBEAT_MCP_RETIRE_PROOF_VARIANT === "main" ? "main" : "fixed";
// Shared sessions retain one child; isolated sessions must retire each fresh child.
const SESSION_MODE =
  process.env.OPENCLAW_HEARTBEAT_MCP_RETIRE_PROOF_SESSION === "shared" ? "shared" : "isolated";
const LABEL = SESSION_MODE === "shared" ? "shared" : VARIANT;

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
let receiptChannel: FixtureReceiptChannel | undefined;

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  } finally {
    const receipts = receiptChannel;
    receiptChannel = undefined;
    await receipts?.close();
  }
});

type CronJob = {
  agentId?: string;
  id: string;
  payload: { kind: string };
};
type CronRunEntry = { error?: string; runId?: string; status?: string };
type ProbeCount = { count: number; pids: number[] };
type ProofCount = ProbeCount & { stage: string };

function writeTextResponse(response: ServerResponse, text: string): void {
  const message = {
    type: "message",
    id: `hb-mcp-retire-${randomUUID()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `hb-mcp-retire-response-${randomUUID()}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

async function startMockProvider() {
  let responsesRequests = 0;
  // Hold the run live during its PID census: a later zero must mean retired.
  let responseGate = createDeferred();
  responseGate.resolve();
  let responseEntered = createDeferred();
  const holdNextResponse = () => {
    responseEntered = createDeferred();
    responseGate = createDeferred();
    return responseEntered.promise;
  };
  const server = createNativeProvider(
    async (request, response, body) => {
      const json = (data: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(data));
      };
      if (request.method === "GET" && request.url === "/v1/models") {
        json({ data: [{ id: "gpt-5.6-luna", object: "model" }] });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/embeddings") {
        const inputs = JSON.parse(body) as { input?: string | string[] };
        const texts = Array.isArray(inputs.input) ? inputs.input : [inputs.input ?? ""];
        json({
          object: "list",
          model: "text-embedding-3-small",
          data: texts.map((_text, index) => ({
            object: "embedding",
            index,
            embedding: Array.from({ length: 64 }, (_slot, dimension) => (dimension === 0 ? 1 : 0)),
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      responsesRequests += 1;
      responseEntered.resolve();
      await responseGate.promise;
      writeTextResponse(response, RESPONSE_TEXT);
    },
    (error, response) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(error instanceof Error ? error.message : String(error));
    },
  );
  const baseUrl = await listenNativeProvider(server);
  return {
    baseUrl,
    get responsesRequests() {
      return responsesRequests;
    },
    holdNextResponse,
    releaseResponse: () => responseGate.resolve(),
    stop: async () => {
      responseGate.resolve();
      await closeNativeProvider(server);
    },
  };
}

async function writeMcpProbeScript(repoRoot: string, marker: string, receiptEndpoint: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-mcp-probe-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const require = createRequire(path.join(repoRoot, "package.json"));
  const mcpUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
  const stdioUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
  const scriptPath = path.join(dir, `${marker}.mjs`);
  await fs.writeFile(
    scriptPath,
    [
      fixtureReceiptClientSource(receiptEndpoint),
      `const { McpServer } = await import(${JSON.stringify(mcpUrl)});`,
      `const { StdioServerTransport } = await import(${JSON.stringify(stdioUrl)});`,
      `const server = new McpServer({ name: ${JSON.stringify(marker)}, version: "1.0.0" });`,
      `server.registerTool("leak_probe_ping", { description: "Heartbeat MCP leak probe" }, async () => ({`,
      `  content: [{ type: "text", text: "pong:" + process.pid }],`,
      `}));`,
      `await server.connect(new StdioServerTransport());`,
      `sendReceipt(${JSON.stringify(scriptPath)}, "connected");`,
      "",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
}

async function countProbeProcesses(marker: string, signal?: AbortSignal): Promise<ProbeCount> {
  // Character class keeps pgrep from matching its own command line.
  const pattern = `[${marker[0]}]${marker.slice(1)}`;
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", pattern], { signal });
    const pids = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid));
    return { count: pids.length, pids };
  } catch (error) {
    // pgrep exits 1 when nothing matches.
    if (typeof error === "object" && error && (error as { code?: unknown }).code === 1) {
      return { count: 0, pids: [] };
    }
    throw error;
  }
}

it.runIf(process.env.OPENCLAW_HEARTBEAT_MCP_RETIRE_PROOF === "1")(
  `retires the isolated heartbeat MCP stdio child after each run (${LABEL})`,
  { timeout: TEST_TIMEOUT_MS },
  async ({ signal }) => {
    const receipts = await openFixtureReceiptChannel();
    receiptChannel = receipts;
    const repoRoot = process.cwd();
    const marker = `hb-mcp-leak-probe-${randomUUID().slice(0, 8)}`;
    const scriptPath = await writeMcpProbeScript(repoRoot, marker, receipts.endpoint);
    const provider = await startMockProvider();
    cleanups.push(() => provider.stop());

    const counts: ProofCount[] = [];
    const record = async (stage: string, probe?: ProbeCount) => {
      const entry = {
        stage,
        ...(probe ?? (await countProbeProcesses(marker))),
      };
      counts.push(entry);
      return entry;
    };
    // Settlement doesn't prove process closure; poll until the signal aborts.
    const settle = async (stage: string, isExpected: (probe: ProbeCount) => boolean) => {
      let probe: ProbeCount | undefined;
      try {
        for (;;) {
          signal.throwIfAborted();
          probe = await withinTest(countProbeProcesses(marker, signal), signal);
          if (isExpected(probe)) {
            return record(stage, probe);
          }
          await sleep(100, undefined, { signal });
        }
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
        if (probe) {
          await record(stage, probe);
        }
        throw new Error(
          `MCP process census aborted during ${stage}; last census=${probe ? JSON.stringify(probe) : "unavailable"}`,
          { cause: error },
        );
      }
    };
    let sharedPid: number | undefined;
    const expectedAfterRun = (run: number) => (probe: ProbeCount) => {
      if (SESSION_MODE === "shared") {
        return probe.pids.length === 1 && probe.pids[0] === sharedPid;
      }
      return probe.count === (VARIANT === "fixed" ? 0 : run);
    };

    await record("before-gateway-start");
    const gatewayOwner = createQaGatewayChild();
    cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
    const gateway = await gatewayOwner.start({
      repoRoot,
      // Cold source-mode startup exceeds the QA child's 120 s listen deadline.
      command: {
        executablePath: process.execPath,
        argsPrefix: ["dist/index.js"],
        cwd: repoRoot,
        usePackagedPlugins: true,
      },
      providerBaseUrl: provider.baseUrl,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      runtimeEnvPatch: { OPENCLAW_SKIP_CHANNELS: "1" },
      mutateConfig: (config) => {
        config.logging = { ...config.logging, level: "debug" };
        for (const entry of Object.values(config.models?.providers ?? {})) {
          entry.timeoutSeconds = 30;
        }
        config.mcp ??= {};
        config.mcp.servers ??= {};
        config.mcp.servers.leakprobe = {
          command: process.execPath,
          args: [scriptPath],
          transport: "stdio",
        };
        config.agents ??= {};
        config.agents.defaults ??= {};
        // Only forced runs execute during this proof.
        config.agents.defaults.heartbeat = {
          every: "24h",
          isolatedSession: SESSION_MODE === "isolated",
          target: "none",
          lightContext: true,
        };
        return config;
      },
    });
    await record("after-gateway-start");
    const call = <T>(method: string, params: Record<string, unknown>) =>
      gateway.call(method, params, { timeoutMs: 15_000 }) as Promise<T>;

    // The system-owned monitor appears once cron reconciles at startup.
    let monitor: CronJob | undefined;
    const listDeadline = Date.now() + 60_000;
    while (!monitor && Date.now() < listDeadline) {
      const listed = await call<{ jobs: CronJob[] }>("cron.list", { includeDisabled: true });
      monitor = listed.jobs.find(
        (job) => job.payload.kind === "heartbeat" && (job.agentId ?? "qa") === "qa",
      );
      if (!monitor) {
        await sleep(500);
      }
    }
    if (!monitor) {
      throw new Error("system-owned qa heartbeat monitor was not listed");
    }
    for (let run = 1; run <= HEARTBEAT_RUNS; run += 1) {
      const requestsBefore = provider.responsesRequests;
      const responseEntered = provider.holdNextResponse();
      const forced = await call<{ ok: boolean; runId: string }>("cron.run", {
        id: monitor.id,
        mode: "force",
      });
      expect(forced).toMatchObject({ ok: true, runId: expect.any(String) });
      // Hold the response through the PID census to prove the child was alive.
      let peak: ProbeCount;
      try {
        await withinTest(
          Promise.all([
            receipts.waitFor(scriptPath, "connected", SESSION_MODE === "shared" ? 1 : run),
            responseEntered,
          ]),
          signal,
        );
        peak = await countProbeProcesses(marker);
      } finally {
        provider.releaseResponse();
      }
      let entry: CronRunEntry | undefined;
      const runDeadline = Date.now() + 120_000;
      while (!entry && Date.now() < runDeadline) {
        const live = await countProbeProcesses(marker);
        if (live.count > peak.count) {
          peak = live;
        }
        const history = await call<{ entries: CronRunEntry[] }>("cron.runs", {
          id: monitor.id,
          runId: forced.runId,
          limit: 1,
        });
        entry = history.entries.find((candidate) => candidate.runId === forced.runId);
        if (!entry) {
          await sleep(100);
        }
      }
      sharedPid ??= peak.pids[0];
      await record(`during-heartbeat-${run}-peak`, peak);
      const status = {
        status: entry?.status,
        providerRequests: provider.responsesRequests - requestsBefore,
      };
      expect(status.status).toBe("ok");
      expect(status.providerRequests).toBeGreaterThan(0);
      await settle(`after-heartbeat-${run}`, expectedAfterRun(run));
    }

    await stopQaGatewayFixture(gatewayOwner);
    await settle("after-gateway-stop", (probe) => probe.count === 0);

    const afterRuns = counts.filter((entry) => entry.stage.startsWith("after-heartbeat-"));
    const peaks = counts.filter((entry) => entry.stage.startsWith("during-heartbeat-"));
    expect(afterRuns).toHaveLength(HEARTBEAT_RUNS);
    expect(peaks).toHaveLength(HEARTBEAT_RUNS);
    for (const entry of peaks) {
      expect(entry.count, `${entry.stage} should observe the MCP child mid-run`).toBeGreaterThan(0);
    }
    if (SESSION_MODE === "shared") {
      expect(sharedPid).toBeDefined();
      for (const entry of [...peaks, ...afterRuns]) {
        expect(entry.pids, `${entry.stage} should reuse the shared MCP child`).toEqual([sharedPid]);
      }
    } else if (VARIANT === "fixed") {
      for (const entry of afterRuns) {
        expect(entry.count, `${entry.stage} should retire the MCP child`).toBe(0);
      }
    } else {
      for (const [index, entry] of afterRuns.entries()) {
        expect(entry.count, `${entry.stage} should leak one child per run`).toBe(index + 1);
      }
    }
    expect(counts.at(-1)?.count, "gateway shutdown must reap every probe").toBe(0);
  },
);
