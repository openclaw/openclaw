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
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { writeFixtureReply } from "./gateway-recovery.test-support.js";
import { startMemoryProofProvider } from "./memory-product-proof.test-support.js";

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

function writeTextResponse(response: ServerResponse, text: string): void {
  writeFixtureReply(
    response,
    text,
    `hb-mcp-retire-${randomUUID()}`,
    `hb-mcp-retire-response-${randomUUID()}`,
  );
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
  const provider = await startMemoryProofProvider(async (response) => {
    responsesRequests += 1;
    responseEntered.resolve();
    await responseGate.promise;
    writeTextResponse(response, RESPONSE_TEXT);
  });
  return {
    ...provider,
    get responsesRequests() {
      return responsesRequests;
    },
    holdNextResponse,
    releaseResponse: () => responseGate.resolve(),
    stop: async () => {
      responseGate.resolve();
      await provider.stop();
    },
  };
}

async function writeMcpProbeScript(repoRoot: string, marker: string, receiptEndpoint: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-mcp-probe-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const require = createRequire(path.join(repoRoot, "package.json"));
  const mcpUrl = pathToFileURL(require.resolve("@modelcontextprotocol/server")).href;
  const stdioUrl = pathToFileURL(require.resolve("@modelcontextprotocol/server/stdio")).href;
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

    // Settlement doesn't prove process closure; poll until the signal aborts.
    const settle = async (stage: string, isExpected: (probe: ProbeCount) => boolean) => {
      let probe: ProbeCount | undefined;
      try {
        for (;;) {
          signal.throwIfAborted();
          probe = await withinTest(countProbeProcesses(marker, signal), signal);
          if (isExpected(probe)) {
            return probe;
          }
          await sleep(100, undefined, { signal });
        }
      } catch (error) {
        if (!signal.aborted) {
          throw error;
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
      expect(peak.count, `heartbeat ${run} should observe the MCP child mid-run`).toBeGreaterThan(
        0,
      );
      if (SESSION_MODE === "shared") {
        expect(sharedPid).toBeDefined();
        expect(peak.pids).toEqual([sharedPid]);
      }
      const status = {
        status: entry?.status,
        providerRequests: provider.responsesRequests - requestsBefore,
      };
      expect(status.status).toBe("ok");
      expect(status.providerRequests).toBeGreaterThan(0);
      const settled = await settle(`after-heartbeat-${run}`, expectedAfterRun(run));
      if (SESSION_MODE === "shared") {
        expect(settled.pids).toEqual([sharedPid]);
      } else {
        expect(settled.count).toBe(VARIANT === "fixed" ? 0 : run);
      }
    }

    await stopQaGatewayFixture(gatewayOwner);
    const stopped = await settle("after-gateway-stop", (probe) => probe.count === 0);
    expect(stopped.count, "gateway shutdown must reap every probe").toBe(0);
  },
);
