import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

/**
 * Live product proof for #143381: an isolated heartbeat run mints a fresh
 * session ID, so its bundle MCP stdio runtime is never reused. Before the fix
 * nothing retired it, and every heartbeat left one MCP child process alive.
 *
 * The proof counts fixture MCP child processes around forced heartbeat runs on
 * a built Gateway. Variant labeling comes from the environment so the same
 * test can record the pre-fix (main) and fixed behavior.
 */

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const RESPONSE_TEXT = "HEARTBEAT_OK";
const HEARTBEAT_RUNS = 3;
const SETTLE_MS = 5_000;
const TEST_TIMEOUT_MS = 600_000;
const VARIANT =
  process.env.OPENCLAW_HEARTBEAT_MCP_RETIRE_PROOF_VARIANT === "main" ? "main" : "fixed";
// Shared heartbeats keep one persistent session runtime; isolated ones mint a
// session per run and must retire it. Both live here so the control stays adjacent.
const SESSION_MODE =
  process.env.OPENCLAW_HEARTBEAT_MCP_RETIRE_PROOF_SESSION === "shared" ? "shared" : "isolated";
const LABEL = SESSION_MODE === "shared" ? "shared" : VARIANT;
const PROOF_OUT_DIR = process.env.OPENCLAW_HEARTBEAT_MCP_RETIRE_PROOF_OUT;

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

type CronJob = {
  agentId?: string;
  declarationKey?: string;
  enabled: boolean;
  id: string;
  payload: { kind: string };
};
type CronRunEntry = { error?: string; runId?: string; status?: string };
type ProofCount = { stage: string; count: number; pids: number[]; at: string };

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
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/embeddings") {
        const inputs = JSON.parse(body) as { input?: string | string[] };
        const texts = Array.isArray(inputs.input) ? inputs.input : [inputs.input ?? ""];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            model: "text-embedding-3-small",
            data: texts.map((_text, index) => ({
              object: "embedding",
              index,
              embedding: Array.from({ length: 64 }, (_slot, dimension) =>
                dimension === 0 ? 1 : 0,
              ),
            })),
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      responsesRequests += 1;
      writeTextResponse(response, RESPONSE_TEXT);
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get responsesRequests() {
      return responsesRequests;
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** Writes a minimal stdio MCP server whose cmdline carries a unique marker. */
async function writeMcpProbeScript(repoRoot: string, marker: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-mcp-probe-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const require = createRequire(path.join(repoRoot, "package.json"));
  const mcpUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
  const stdioUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
  const scriptPath = path.join(dir, `${marker}.mjs`);
  await fs.writeFile(
    scriptPath,
    [
      `const { McpServer } = await import(${JSON.stringify(mcpUrl)});`,
      `const { StdioServerTransport } = await import(${JSON.stringify(stdioUrl)});`,
      `const server = new McpServer({ name: ${JSON.stringify(marker)}, version: "1.0.0" });`,
      `server.registerTool("leak_probe_ping", { description: "Heartbeat MCP leak probe" }, async () => ({`,
      `  content: [{ type: "text", text: "pong:" + process.pid }],`,
      `}));`,
      `await server.connect(new StdioServerTransport());`,
      "",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
}

/** Counts live processes whose cmdline carries the probe marker (pgrep excludes itself). */
async function countProbeProcesses(marker: string): Promise<{ count: number; pids: number[] }> {
  const pattern = `[${marker[0]}]${marker.slice(1)}`;
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
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

type GatewayLogSource = { workspaceDir: string; tempRoot: string };

async function readLogFiles(gateway: GatewayLogSource): Promise<Map<string, string>> {
  const logsDir = path.join(gateway.workspaceDir, "logs");
  const names = (await fs.readdir(logsDir).catch(() => [])).filter((name) => name.endsWith(".log"));
  const files = [
    ...names.toSorted().map((name) => path.join(logsDir, name)),
    path.join(gateway.tempRoot, "gateway.stdout.log"),
    path.join(gateway.tempRoot, "gateway.stderr.log"),
  ];
  const entries = await Promise.all(
    files.map(async (file) => [file, await fs.readFile(file, "utf8").catch(() => "")] as const),
  );
  return new Map(entries);
}

function redact(text: string, replacements: Array<[string, string]>): string {
  let out = text;
  for (const [needle, label] of replacements) {
    if (needle) {
      out = out.replaceAll(needle, label);
    }
  }
  return out
    .replace(/(token|secret|apiKey|api_key|authorization)(["'=: ]+)[^\s"',}]+/gi, "$1$2<redacted>")
    .replace(/Bearer\s+\S+/g, "Bearer <redacted>")
    .replace(/\/(?:home|Users)\/[^/\s"'│]+/g, "<home>")
    .replaceAll(os.hostname(), "<host>");
}

describe.runIf(process.env.OPENCLAW_HEARTBEAT_MCP_RETIRE_PROOF === "1")(
  "Isolated heartbeat bundle MCP runtime retirement product proof",
  () => {
    it(
      `retires the isolated heartbeat MCP stdio child after each run (${LABEL})`,
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const repoRoot = process.cwd();
        const marker = `hb-mcp-leak-probe-${randomUUID().slice(0, 8)}`;
        const scriptPath = await writeMcpProbeScript(repoRoot, marker);
        const provider = await startMockProvider();
        cleanups.push(() => provider.stop());

        const counts: ProofCount[] = [];
        const record = async (stage: string) => {
          const probe = await countProbeProcesses(marker);
          const entry = { stage, ...probe, at: new Date().toISOString() };
          counts.push(entry);
          console.log(JSON.stringify({ phase: "hb-mcp-count", variant: LABEL, ...entry }));
          return entry;
        };

        await record("before-gateway-start");
        const gatewayOwner = createQaGatewayChild();
        cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
        const gateway = await gatewayOwner.start({
          repoRoot,
          // Built Gateway: source-mode tsx startup alone exceeds the QA child's
          // 120 s listen deadline on a cold checkout.
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          providerBaseUrl: `${provider.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          runtimeEnvPatch: { OPENCLAW_SKIP_CHANNELS: "1" },
          mutateConfig: (config) => ({
            ...config,
            logging: { ...config.logging, level: "debug" },
            models: config.models
              ? {
                  ...config.models,
                  providers: Object.fromEntries(
                    Object.entries(config.models.providers ?? {}).map(([id, entry]) => [
                      id,
                      { ...entry, timeoutSeconds: 30 },
                    ]),
                  ),
                }
              : config.models,
            mcp: {
              ...config.mcp,
              servers: {
                ...config.mcp?.servers,
                leakprobe: { command: process.execPath, args: [scriptPath], transport: "stdio" },
              },
            },
            agents: {
              ...config.agents,
              defaults: {
                ...config.agents?.defaults,
                // 24h cadence: only the forced cron.run wakes below execute, so
                // every count maps to one known heartbeat run.
                heartbeat: {
                  every: "24h",
                  isolatedSession: SESSION_MODE === "isolated",
                  target: "none",
                  lightContext: true,
                },
              },
            },
          }),
        });
        await record("after-gateway-start");

        // The system-owned monitor appears once cron reconciles at startup.
        let monitor: CronJob | undefined;
        const listDeadline = Date.now() + 60_000;
        while (!monitor && Date.now() < listDeadline) {
          const listed = (await gateway.call(
            "cron.list",
            { includeDisabled: true },
            { timeoutMs: 15_000 },
          )) as { jobs: CronJob[] };
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
        console.log(JSON.stringify({ phase: "hb-mcp-monitor", monitor }));

        const heartbeatStatuses: Array<{
          run: number;
          runId: string;
          status?: string;
          error?: string;
          providerRequests: number;
        }> = [];
        for (let run = 1; run <= HEARTBEAT_RUNS; run += 1) {
          const requestsBefore = provider.responsesRequests;
          const forced = (await gateway.call(
            "cron.run",
            { id: monitor.id, mode: "force" },
            { timeoutMs: 15_000 },
          )) as { ok: boolean; enqueued: boolean; runId: string };
          expect(forced).toMatchObject({ ok: true, runId: expect.any(String) });
          let entry: CronRunEntry | undefined;
          let peak = { count: 0, pids: [] as number[] };
          const runDeadline = Date.now() + 120_000;
          while (!entry && Date.now() < runDeadline) {
            // Sample while the run is live: the child must exist mid-run for a
            // later zero to mean "retired" rather than "never spawned".
            const live = await countProbeProcesses(marker);
            if (live.count > peak.count) {
              peak = live;
            }
            const history = (await gateway.call(
              "cron.runs",
              { id: monitor.id, runId: forced.runId, limit: 1 },
              { timeoutMs: 15_000 },
            )) as { entries: CronRunEntry[] };
            entry = history.entries.find((candidate) => candidate.runId === forced.runId);
            if (!entry) {
              await sleep(100);
            }
          }
          counts.push({
            stage: `during-heartbeat-${run}-peak`,
            ...peak,
            at: new Date().toISOString(),
          });
          console.log(JSON.stringify({ phase: "hb-mcp-count", variant: LABEL, ...counts.at(-1) }));
          const status = {
            run,
            runId: forced.runId,
            status: entry?.status,
            error: entry?.error,
            providerRequests: provider.responsesRequests - requestsBefore,
          };
          heartbeatStatuses.push(status);
          console.log(JSON.stringify({ phase: "hb-mcp-heartbeat", variant: LABEL, ...status }));
          expect(status.status).toBe("ok");
          expect(status.providerRequests).toBeGreaterThan(0);
          await sleep(SETTLE_MS);
          await record(`after-heartbeat-${run}`);
        }

        const logs = await readLogFiles(gateway);
        const replacements: Array<[string, string]> = [
          [gateway.tempRoot, "<tempRoot>"],
          [gateway.workspaceDir, "<workspaceDir>"],
          [scriptPath, "<probeScript>"],
          [repoRoot, "<repoRoot>"],
          [os.homedir(), "<home>"],
        ];
        const interesting = /leakprobe|leak_probe|bundle-mcp|heartbeat|agent cleanup/i;
        const excerpts = [...logs]
          .map(([file, text]) => ({
            file: redact(file, replacements),
            lines: text
              .split("\n")
              .filter((line) => interesting.test(line))
              .map((line) => redact(line, replacements)),
          }))
          .filter((entry) => entry.lines.length > 0);

        const packageVersion = (
          JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as {
            version?: string;
          }
        ).version;
        const gitHead = (
          await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot }).catch(
            () => ({ stdout: "unknown" }),
          )
        ).stdout.trim();
        const gatewayVersion = `${packageVersion ?? "unknown"}@${gitHead}`;

        await stopQaGatewayFixture(gatewayOwner);
        await sleep(1_000);
        await record("after-gateway-stop");

        const proof = {
          variant: LABEL,
          build: VARIANT,
          sessionMode: SESSION_MODE,
          issue: 143381,
          marker,
          counts: counts.map(({ stage, count }) => ({ stage, count })),
          countsDetailed: counts,
          heartbeatStatuses,
          gatewayVersion,
          timestamps: { startedAt: counts[0]?.at, finishedAt: new Date().toISOString() },
        };
        console.log(`HB_MCP_RETIRE_PROOF ${JSON.stringify(proof)}`);
        if (PROOF_OUT_DIR) {
          await fs.mkdir(PROOF_OUT_DIR, { recursive: true });
          await fs.writeFile(
            path.join(PROOF_OUT_DIR, `proof-${LABEL}.json`),
            `${JSON.stringify(proof, null, 2)}\n`,
            "utf8",
          );
          await fs.writeFile(
            path.join(PROOF_OUT_DIR, `gateway-log-excerpts-${LABEL}.txt`),
            excerpts.map((entry) => `### ${entry.file}\n${entry.lines.join("\n")}\n`).join("\n"),
            "utf8",
          );
        }

        const afterRuns = counts.filter((entry) => entry.stage.startsWith("after-heartbeat-"));
        const peaks = counts.filter((entry) => entry.stage.startsWith("during-heartbeat-"));
        expect(afterRuns).toHaveLength(HEARTBEAT_RUNS);
        expect(peaks).toHaveLength(HEARTBEAT_RUNS);
        for (const entry of peaks) {
          expect(
            entry.count,
            `${entry.stage} should observe the MCP child mid-run`,
          ).toBeGreaterThan(0);
        }
        if (SESSION_MODE === "shared") {
          // One persistent runtime serves every shared run: same child, never retired mid-life.
          const sharedPid = peaks[0]?.pids[0];
          expect(sharedPid).toBeDefined();
          for (const entry of [...peaks, ...afterRuns]) {
            expect(entry.pids, `${entry.stage} should reuse the shared MCP child`).toEqual([
              sharedPid,
            ]);
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
  },
);
