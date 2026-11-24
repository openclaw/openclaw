/**
 * Real sessions.compact residency regression: local held Completions, no credentials/live state.
 * pnpm test test/gateway-compaction-residency.e2e.test.ts --maxWorkers=1
 * Or node --import ./scripts/tsx.mjs test/gateway-compaction-residency.e2e.test.ts --root <checkout>
 * Run the SAME script against original 4dbd70ff and candidate (serial ABAB for timings).
 * Default 8/40 MiB, fixed 16-KiB retained ask and 32k model window. --sizes 1,2 is setup smoke;
 * --check-only checks fixture/import/observer contracts without starting a Gateway.
 * Acceptance: no removed tool payload hydrated on main, one extraction, selected reads bounded,
 * held post-GC heap growth < 0.25 bytes/source byte. Peak is OBSERVED, not an absolute V8 peak.
 * This instrumented regression is not a latency benchmark or an uninstrumented cold campaign.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentMessage } from "../packages/agent-core/src/types.js";
import type { SessionEntry } from "../src/agents/sessions/session-manager-types.js";
import type { SessionPreparedCompactionValue } from "../src/config/sessions/session-compaction-prepared.types.js";

const MiB = 1024 * 1024;
const key = "agent:main:residency-proof";
const sessionId = "residency-proof";
const summary =
  "## Decisions\n- The historical fixture inspections are complete.\n\n## Open TODOs\n- Answer the retained user ask.\n\n## Constraints/Rules\n- Use the retained context.\n\n## Pending user asks\n- Continue the synthetic task.\n\n## Exact identifiers\n- kept-ask";
const retained: AgentMessage = {
  role: "user",
  content: "Please continue the synthetic task: kept-ask. ".padEnd(16_384, "k"),
  timestamp: 1_000_000,
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
): AgentMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "residency",
  model: "fixture",
  usage,
  stopReason: "stop",
  timestamp: 1,
});
function fixture(size: number) {
  const entries: SessionEntry[] = [];
  const append = (message: AgentMessage) =>
    entries.push({
      type: "message",
      id: `row-${entries.length}`,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    });
  let payloadBytes = 0;
  for (let index = 0; payloadBytes < size; index++) {
    const bytes = [2, 8, 32, 64, 190][index % 5]! * 1024;
    append({ role: "user", content: `Please inspect historical fixture ${index}.`, timestamp: 1 });
    append(
      assistant([
        {
          type: "toolCall",
          id: `historical-${index}`,
          name: "read",
          arguments: { path: "synthetic.txt" },
        },
      ]),
    );
    append({
      role: "toolResult",
      toolCallId: `historical-${index}`,
      toolName: "read",
      content: [{ type: "text", text: `Synthetic output ${index}. `.padEnd(bytes, "x") }],
      isError: false,
      timestamp: 1,
    });
    append(assistant([{ type: "text", text: `Inspection ${index} complete.` }]));
    payloadBytes += bytes;
  }
  append(retained);
  return { entries, payloadBytes };
}
const observers = [
  [
    "src/config/sessions/session-transcript-hydration-decoder.ts",
    "events.push(JSON.parse(json));",
    'events.push(JSON.parse(json)); globalThis[Symbol.for("compaction-residency")].row(events[events.length - 1]);',
  ],
  [
    "src/config/sessions/session-compaction-prepared.ts",
    "      return result;",
    '      globalThis[Symbol.for("compaction-residency")].prepared(operation.kind, result); return result;',
  ],
] as const;
function instrument(root: string, file: string) {
  const [, anchor, replacement] = observers.find(([owner]) => owner === file)!;
  const source = readFileSync(path.join(root, file), "utf8");
  assert.equal(source.split(anchor).length, 2, `Observer anchor changed: ${file}`);
  return source.replace(anchor, replacement);
}
const gateway = process.argv[2] === "gateway";
const { values } = parseArgs({
  args: gateway || process.env.VITEST ? [] : process.argv.slice(2),
  options: {
    root: { type: "string", default: process.cwd() },
    sizes: { type: "string", default: process.env.COMPACTION_RESIDENCY_SIZES ?? "8,40" },
    "check-only": { type: "boolean", default: false },
  },
});
const root = path.resolve(process.env.COMPACTION_RESIDENCY_ROOT ?? values.root);
const source = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const fingerprint = () =>
  createHash("sha256")
    .update(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }))
    .update(
      execFileSync("git", ["diff", "HEAD", "--", "src", "packages"], {
        cwd: root,
        maxBuffer: 16 * MiB,
      }),
    )
    .digest("hex");

if (gateway) {
  let active = false;
  let peakObservedHeapBytes = 0;
  let mainRemovedPayloadHydrationBytes = 0;
  const reads: Array<{ operation: string; status: string; reads: unknown }> = [];
  const installed = new Set<string>();
  const observe = {
    row(entry: SessionEntry) {
      if (
        active &&
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId.startsWith("historical-")
      ) {
        mainRemovedPayloadHydrationBytes += entry.message.content.reduce(
          (sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
          0,
        );
      }
      if (active) {
        peakObservedHeapBytes = Math.max(peakObservedHeapBytes, process.memoryUsage().heapUsed);
      }
    },
    prepared(operation: string, result: SessionPreparedCompactionValue) {
      if (active) {
        reads.push({ operation, status: result.status, reads: result.reads ?? null });
        peakObservedHeapBytes = Math.max(peakObservedHeapBytes, process.memoryUsage().heapUsed);
      }
    },
  };
  Object.assign(globalThis, { [Symbol.for("compaction-residency")]: observe });
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const owner = observers.find(
        ([file]) => url === pathToFileURL(path.join(root, file)).href,
      )?.[0];
      if (!owner) {
        return loaded;
      }
      installed.add(owner);
      return { ...loaded, format: "module-typescript", source: instrument(root, owner) };
    },
  });
  const inspector = new Session();
  inspector.connect();
  const {
    startGatewayBenchDiagnostics,
  }: typeof import("../scripts/lib/gateway-bench-diagnostics.ts") = await source(
    "scripts/lib/gateway-bench-diagnostics.ts",
  );
  let finishDiagnostics: (() => unknown) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const diagnostics = createServer((request, response) => {
    void (async () => {
      if (request.url === "/start") {
        reads.length = 0;
        mainRemovedPayloadHydrationBytes = 0;
        await inspector.post("HeapProfiler.collectGarbage");
        peakObservedHeapBytes = process.memoryUsage().heapUsed;
        active = true;
        finishDiagnostics = startGatewayBenchDiagnostics();
        timer = setInterval(() => {
          peakObservedHeapBytes = Math.max(peakObservedHeapBytes, process.memoryUsage().heapUsed);
        }, 10);
      } else if (request.url === "/held") {
        clearInterval(timer);
        await inspector.post("HeapProfiler.collectGarbage");
      } else if (request.url === "/finish") {
        active = false;
        clearInterval(timer);
      } else {
        throw new Error("Unknown diagnostic operation");
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          pid: process.pid,
          heap: await inspector.post("Runtime.getHeapUsage"),
          peakObservedHeapBytes,
          mainRemovedPayloadHydrationBytes,
          reads,
          installed: [...installed],
          ...(active ? {} : { diagnostics: finishDiagnostics?.() }),
        }),
      );
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => {
    diagnostics.listen(0, "127.0.0.1", resolve);
  });
  const address = diagnostics.address();
  assert(address && typeof address !== "string");
  console.log(`RESIDENCY_DIAGNOSTICS http://127.0.0.1:${address.port}`);
  const { startGatewayServer }: typeof import("../src/gateway/server.ts") =
    await source("src/gateway/server.ts");
  const server = await startGatewayServer(
    Number(process.argv[process.argv.indexOf("--port") + 1]),
    { bind: "loopback", controlUiEnabled: false },
  );
  process.once("SIGTERM", () => {
    void server.close({ reason: "residency proof complete" }).finally(() => {
      clearInterval(timer);
      diagnostics.closeAllConnections();
      diagnostics.close();
      inspector.disconnect();
    });
  });
} else {
  async function runProof() {
    for (const [file] of observers) {
      instrument(root, file);
    }
    const { createOpenClawTestInstance }: typeof import("./helpers/openclaw-test-instance.js") =
      await source("test/helpers/openclaw-test-instance.ts");
    const {
      BASE_GATEWAY_BENCH_CONFIG,
      createGatewayBenchEnv,
    }: typeof import("../scripts/lib/gateway-bench-runtime.ts") = await source(
      "scripts/lib/gateway-bench-runtime.ts",
    );
    const {
      readGatewayBenchHostCounters,
    }: typeof import("../scripts/lib/gateway-bench-probes.ts") = await source(
      "scripts/lib/gateway-bench-probes.ts",
    );
    const {
      connectProofClient,
      listenLoopback,
      closeHttpServer,
    }: typeof import("./helpers/gateway-integration-fixtures.js") = await source(
      "test/helpers/gateway-integration-fixtures.ts",
    );
    const { runQaGatewayFixture }: typeof import("./helpers/qa-gateway-cleanup.js") = await source(
      "test/helpers/qa-gateway-cleanup.ts",
    );
    if (values["check-only"]) {
      const seeded = fixture(MiB);
      assert(seeded.payloadBytes >= MiB && seeded.payloadBytes < MiB + 190 * 1024);
      assert.deepEqual(
        seeded.entries.findLast((entry) => entry.type === "message")?.message,
        retained,
      );
      console.log(
        JSON.stringify({
          checked: "fixture, observer anchors, isolated Gateway helper imports",
          sourceFingerprint: fingerprint(),
          fixtureRows: seeded.entries.length,
        }),
      );
    } else {
      const sizes = values.sizes.split(",").map(Number);
      assert(
        sizes.length === 2 &&
          sizes.every((size) => Number.isFinite(size) && size > 0) &&
          sizes[1]! > sizes[0]!,
      );
      const sourceFingerprint = fingerprint();
      const results = [];
      for (const size of sizes) {
        const held = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const errors: unknown[] = [];
        let requestBytes = 0;
        let requests = 0;
        const provider = createServer((request, response) => {
          void (async () => {
            assert.equal(request.method, "POST");
            assert.equal(request.url, "/v1/chat/completions");
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              const bytes = Buffer.from(chunk);
              requestBytes += bytes.length;
              assert(requestBytes <= 256 * 1024, "Summary request exceeded fixed budget");
              chunks.push(bytes);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            assert.equal(body.model, "fixture");
            assert.match(JSON.stringify(body.messages), /context summarization assistant/i);
            assert.equal(++requests, 1, "Expected one dedicated summary request");
            held.resolve();
            await release.promise;
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const choice of [
              { delta: { role: "assistant", content: summary }, finish_reason: null },
              { delta: {}, finish_reason: "stop" },
            ]) {
              response.write(
                `data: ${JSON.stringify({ id: "fixture-summary", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`,
              );
            }
            response.end("data: [DONE]\n\n");
          })().catch((error: unknown) => {
            errors.push(error);
            held.reject(error);
            response.destroy();
          });
        });
        const baseUrl = await listenLoopback(provider);
        const instance = await createOpenClawTestInstance({
          name: `compaction-residency-${size}`,
          cwd: root,
          gatewayCommandPrefix: ["node"],
          entrypoint: [
            "--import",
            path.join(root, "scripts/tsx.mjs"),
            fileURLToPath(import.meta.url),
          ],
          gracefulShutdownTimeoutMs: 5_000,
          startTimeoutMs: 120_000,
          config: {
            ...BASE_GATEWAY_BENCH_CONFIG,
            gateway: { ...BASE_GATEWAY_BENCH_CONFIG.gateway, auth: { mode: "token" } },
            plugins: { slots: { memory: "none" } },
            cron: { enabled: false },
            tools: { profile: "minimal" },
            agents: {
              defaults: {
                model: { primary: "residency/fixture" },
                models: { "residency/fixture": { agentRuntime: { id: "openclaw" } } },
                skipBootstrap: true,
                skills: [],
                contextPruning: { mode: "off" },
                compaction: {
                  mode: "safeguard",
                  model: "residency/fixture",
                  keepRecentTokens: 2048,
                  recentTurnsPreserve: 0,
                  identifierPolicy: "off",
                  qualityGuard: { enabled: false },
                  postIndexSync: "off",
                },
              },
            },
            models: {
              mode: "replace",
              providers: {
                residency: {
                  baseUrl: `${baseUrl}/v1`,
                  apiKey: "synthetic-no-secret",
                  api: "openai-completions",
                  request: { allowPrivateNetwork: true },
                  models: [
                    {
                      id: "fixture",
                      name: "Synthetic fixture",
                      api: "openai-completions",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 32768,
                      maxTokens: 2048,
                    },
                  ],
                },
              },
            },
          },
        }).catch(async (error: unknown) => {
          await closeHttpServer(provider);
          throw error;
        });
        const savedEnv = process.env;
        const safeEnv = createGatewayBenchEnv(instance.homeDir, instance.configPath, {
          startupTrace: false,
          caseEnv: {
            OPENCLAW_STATE_DIR: instance.stateDir,
            COMPACTION_RESIDENCY_ROOT: root,
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          },
        });
        for (const name of Object.keys(instance.env)) {
          delete instance.env[name];
        }
        Object.assign(instance.env, safeEnv);
        process.env = safeEnv;
        let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
        try {
          const {
            createSessionEntryWithTranscript,
          }: typeof import("../src/config/sessions/session-accessor.entry-mutation.js") =
            await source("src/config/sessions/session-accessor.entry-mutation.ts");
          const { SessionManager }: typeof import("../src/agents/sessions/session-manager.js") =
            await source("src/agents/sessions/session-manager.ts");
          const target = {
            agentId: "main",
            sessionId,
            sessionKey: key,
            env: safeEnv,
            storePath: path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
          };
          let seeded = fixture(size * MiB);
          const payloadBytes = seeded.payloadBytes;
          const fixtureRows = seeded.entries.length;
          const created = await createSessionEntryWithTranscript(
            target,
            () => ({
              ok: true,
              entry: { sessionId, updatedAt: Date.now(), contextTokens: 32768 },
              transcriptEvents: [
                {
                  type: "session",
                  version: 3,
                  id: sessionId,
                  cwd: instance.state.workspaceDir,
                  timestamp: "2026-01-01T00:00:00.000Z",
                },
                ...seeded.entries,
              ],
            }),
            { cwd: instance.state.workspaceDir },
          );
          assert(created.ok, JSON.stringify(created));
          seeded = { entries: [], payloadBytes: 0 };
          await instance.startGateway();
          client = await connectProofClient(instance, {
            scopes: ["operator.admin", "operator.read", "operator.write"],
          });
          const diagnosticsUrl = /RESIDENCY_DIAGNOSTICS (http:\/\/127\.0\.0\.1:\d+)/.exec(
            instance.logs(),
          )?.[1];
          assert(diagnosticsUrl, "Owned Gateway diagnostic endpoint missing");
          const probe = async (phase: string) => {
            const reply = await fetch(`${diagnosticsUrl}/${phase}`, {
              signal: AbortSignal.timeout(30_000),
            });
            assert(reply.ok, await reply.clone().text());
            return reply.json();
          };
          const host = readGatewayBenchHostCounters();
          const gatewayPid = instance.child?.pid;
          const before = await probe("start");
          let settled = false;
          const compaction = client
            .request<{ ok: boolean; compacted: boolean }>(
              "sessions.compact",
              { key },
              { timeoutMs: 120_000 },
            )
            .finally(() => {
              settled = true;
            });
          void compaction.catch(() => {});
          await Promise.race([
            held.promise,
            compaction.then((result: unknown) => {
              throw new Error(`Compaction settled without held summary: ${JSON.stringify(result)}`);
            }),
          ]);
          const during = await probe("held");
          assert(!settled, "Summary was not unresolved at the post-GC sample");
          release.resolve();
          const result = await compaction;
          assert(result.ok && result.compacted, JSON.stringify(result));
          const after = await probe("finish");
          await client.stopAndWait();
          client = undefined;
          await instance.stopGateway();
          const manager = await SessionManager.openAsync(target);
          const context = manager.buildSessionContext().messages;
          assert.deepEqual(
            context.filter((message: AgentMessage) => message.role === "user"),
            [retained],
            "Kept ask changed",
          );
          assert(
            !context.some((message: AgentMessage) => message.role === "toolResult"),
            "Removed historical tools survived",
          );
          assert(
            JSON.stringify(context).includes("historical fixture inspections are complete"),
            "Provider summary was not persisted",
          );
          assert.equal(requests, 1);
          assert.deepEqual(errors, []);
          assert.equal(before.pid, gatewayPid);
          assert.deepEqual(
            after.installed.toSorted(),
            observers.map(([file]) => file).toSorted(),
            "Both main-isolate observers must be installed",
          );
          assert.equal(before.pid, during.pid);
          assert.equal(after.pid, during.pid);
          const row = {
            sourceFingerprint,
            sizeMiB: size,
            payloadBytes,
            fixtureRows,
            requestBytes,
            requests,
            heldPostGcHeapBytes: during.heap.usedSize,
            heldDeltaBytes: during.heap.usedSize - before.heap.usedSize,
            peakObservedHeapBytes: during.peakObservedHeapBytes,
            mainRemovedPayloadHydrationBytes: after.mainRemovedPayloadHydrationBytes,
            reads: after.reads,
            keptContextSha256: createHash("sha256")
              .update(
                JSON.stringify(context.filter((message: AgentMessage) => message.role === "user")),
              )
              .digest("hex"),
            host,
            diagnostics: after.diagnostics,
          };
          console.log(JSON.stringify({ sample: row }));
          results.push(row);
        } catch (error) {
          console.error(instance.logs());
          throw error;
        } finally {
          release.resolve();
          try {
            await runQaGatewayFixture(
              async () => {},
              () => client?.stopAndWait(),
              () => instance.cleanup(),
              () => closeHttpServer(provider),
            );
          } finally {
            process.env = savedEnv;
          }
        }
      }
      assert.equal(
        fingerprint(),
        sourceFingerprint,
        "Source changed during proof; result is not revision-bound",
      );
      const slope =
        (results[1]!.heldDeltaBytes - results[0]!.heldDeltaBytes) /
        (results[1]!.payloadBytes - results[0]!.payloadBytes);
      const report = {
        table: results.map(({ host: _host, diagnostics: _diagnostics, ...row }) => row),
        heldHeapBytesPerSourceByte: slope,
        acceptance: {
          maxSlope: 0.25,
          removedPayloadHydrationBytes: 0,
        },
      };
      console.log(JSON.stringify(report));
      if (process.env.COMPACTION_RESIDENCY_OUTPUT) {
        writeFileSync(process.env.COMPACTION_RESIDENCY_OUTPUT, JSON.stringify(report, null, 2));
      }
      assert(slope < 0.25, `Main-thread held heap scales with removed history: ${slope}`);
      for (const row of results) {
        assert.equal(
          row.mainRemovedPayloadHydrationBytes,
          0,
          "Removed payload reached the main isolate",
        );
        assert(
          row.reads.some((read: { status: string }) => read.status === "prepared"),
          "Dedicated prepared path not used",
        );
        assert(
          row.reads.every((read: { reads: unknown }) => read.reads),
          "Worker read counters unavailable",
        );
        const totals = row.reads.reduce(
          (
            sum: { extractedRows: number; selectedBytes: number },
            read: { reads: { extractedRows: number; selectedBytes: number } },
          ) => ({
            extractedRows: sum.extractedRows + read.reads.extractedRows,
            selectedBytes: sum.selectedBytes + read.reads.selectedBytes,
          }),
          { extractedRows: 0, selectedBytes: 0 },
        );
        assert.equal(
          totals.extractedRows,
          row.fixtureRows + 1,
          "Expected one source extraction including header",
        );
        // Selected raw rows can be much larger than their bounded rendered excerpts.
        if (row.sizeMiB >= 40) {
          assert(
            totals.selectedBytes < row.payloadBytes,
            "Selected rereads revisited the full large source",
          );
        }
      }
      assert.equal(results[0]!.keptContextSha256, results[1]!.keptContextSha256);
    }
  }
  if (process.env.VITEST) {
    const { it } = await import("vitest");
    it(
      "keeps removed compaction payloads out of the Gateway main isolate",
      { timeout: 300_000 },
      runProof,
    );
  } else {
    await runProof();
  }
}
