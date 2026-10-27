import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createTeamStressFanoutReceipts } from "../../scripts/perf/team-shape-stress-receipts.ts";
import {
  compareStressRuns,
  summarizeStressRun,
  type StressRun,
} from "../../scripts/perf/team-shape-stress-report.ts";
import { parseStressOptions } from "../../scripts/perf/team-shape-stress.ts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const executeFile = promisify(execFile);

it("drains workload receipts despite background metadata, retaining late child and injection delivery", () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const receipts = createTeamStressFanoutReceipts(2, ["churn"]);
    receipts.trackForeground(["parent"], false);
    const child = { sessionKey: "child", messageId: "early" };
    receipts.observe(0, "session.message", child);
    now = 100;
    receipts.trackForeground(["child"], false);
    now = 900;
    receipts.observe(1, "session.message", child);
    now = 1100;
    expect(receipts.isDrained()).toBe(false);
    now = 1900;
    receipts.observe(0, "chat.metadata.changed", { agentId: "main" });
    receipts.observe(1, "sessions.changed", { sessionKey: "cron", reason: "updated" });
    expect(receipts.isDrained()).toBe(true);

    receipts.expectInjection("churn", "committed");
    now = 2900;
    const injection = { sessionKey: "churn", messageId: "committed" };
    receipts.observe(0, "session.message", injection);
    expect(receipts.isDrained(false)).toBe(false);
    receipts.observe(1, "session.message", injection);
    expect(receipts.isDrained(false)).toBe(true);
    expect(receipts.isDrained()).toBe(false);
    now = 3900;
    receipts.observe(1, "chat.metadata.changed", { agentId: "main" });
    expect(receipts.isDrained()).toBe(true);
    expect(() => receipts.assertComplete()).not.toThrow();
  } finally {
    clock.mockRestore();
  }
});

it("checks continuous workload receipts when a background fanout crosses the timing boundary", () => {
  const receipts = createTeamStressFanoutReceipts(2, ["churn"]);
  receipts.trackForeground(["foreground"]);
  let measuring = false;
  const timedMessages = [0, 0];
  const receive = (client: number, sessionKey: string, messageId: string) => {
    if (measuring) {
      timedMessages[client]!++;
    }
    receipts.observe(client, "session.message", { sessionKey, messageId });
  };
  receive(0, "cron", "background");
  receive(0, "foreground", "answer");
  measuring = true;
  receive(1, "cron", "background");
  receive(1, "foreground", "answer");
  // A message may be republished with updated contents; compare delivery multiplicity.
  for (const client of [0, 1]) {
    receive(client, "foreground", "answer");
    receipts.observe(client, "sessions.changed", {
      sessionKey: "foreground",
      reason: "updated",
      ts: 123,
    });
    receive(client, "churn", "committed");
  }
  // The publication can precede the RPC response that names the committed message.
  receipts.expectInjection("churn", "committed");
  expect(timedMessages).toEqual([2, 4]);
  expect(() => receipts.assertComplete()).not.toThrow();
  // A successful checkpoint consumes receipts; a prior round cannot satisfy a later one.
  receipts.trackForeground(["foreground"]);
  expect(() => receipts.assertComplete()).toThrow("missing foreground session.message");
});

it.each([false, true])(
  "checks early native child receipts selected after spawn acceptance (missing: %s)",
  (missing) => {
    const receipts = createTeamStressFanoutReceipts(2, []);
    // Setup publishes before all subscribers connect; collection starts with the workload.
    receipts.observe(0, "sessions.changed", { sessionKey: "parent", reason: "created" });
    receipts.trackForeground(["parent"], false);
    for (const client of [0, 1]) {
      receipts.observe(client, "session.message", { sessionKey: "parent", messageId: "spawn" });
      if (!missing || client === 0) {
        receipts.observe(client, "session.message", { sessionKey: "child", messageId: "early" });
      }
    }
    receipts.trackForeground(["child"], false);
    if (missing) {
      expect(() => receipts.assertComplete()).toThrow('incomplete foreground fanout ["child"');
      return;
    }
    expect(() => receipts.assertComplete()).not.toThrow();
    // Retired children and an idle parent are not mandatory in the next workload.
    receipts.observe(0, "session.message", { sessionKey: "next-child", messageId: "next" });
    receipts.observe(1, "session.message", { sessionKey: "next-child", messageId: "next" });
    receipts.trackForeground(["next-child"], false);
    expect(() => receipts.assertComplete()).not.toThrow();
  },
);

it.each(["one client", "all clients"])(
  "rejects a named committed injection omitted for %s",
  (missing) => {
    const receipts = createTeamStressFanoutReceipts(2, ["churn"]);
    if (missing === "one client") {
      receipts.observe(0, "session.message", { sessionKey: "churn", messageId: "committed" });
    }
    receipts.expectInjection("churn", "committed");
    expect(() => receipts.assertComplete()).toThrow(
      'incomplete chat.inject fanout ["churn","committed"]',
    );
  },
);

it.each([false, true])(
  "keeps an acknowledged injection pending until every client receives it (duplicate: %s)",
  (duplicate) => {
    const receipts = createTeamStressFanoutReceipts(2, ["churn"]);
    receipts.expectInjection("churn", "committed");
    const pending = ['["churn","committed"]'];
    // No recent subscriber event is needed for a successful RPC to leave publication pending.
    expect(receipts.pendingInjections()).toEqual(pending);
    const payload = { sessionKey: "churn", messageId: "committed" };
    receipts.observe(0, "session.message", payload);
    if (duplicate) {
      receipts.observe(0, "session.message", payload);
    }
    expect(receipts.pendingInjections()).toEqual(pending);
    receipts.observe(1, "session.message", payload);
    expect(receipts.pendingInjections()).toEqual([]);
    if (duplicate) {
      expect(() => receipts.assertComplete()).toThrow("incomplete chat.inject fanout");
    } else {
      expect(() => receipts.assertComplete()).not.toThrow();
      expect(receipts.pendingInjections()).toEqual([]);
    }
  },
);

it.each(["session.message", "sessions.changed"])(
  "rejects different foreground %s deliveries even when aggregate counts match",
  (event) => {
    const receipts = createTeamStressFanoutReceipts(2, []);
    receipts.trackForeground(["foreground"]);
    for (const client of [0, 1]) {
      for (const kind of ["session.message", "sessions.changed"]) {
        receipts.observe(client, kind, {
          sessionKey: "foreground",
          messageId: kind === event ? `missing-on-peer-${client}` : "shared",
        });
      }
    }
    expect(() => receipts.assertComplete()).toThrow("incomplete foreground fanout");
  },
);

it("loads source worker telemetry through built package exports without redirecting built imports", async () => {
  const root = temporary.make("team-stress-worker-telemetry-");
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  for (const [name, subpath, symbol] of [
    ["normalization-core", "record-coerce", "isRecord"],
    ["worker-runtime", "lifecycle", "createRetainedOperation"],
  ]) {
    const pkg = path.join(root, "packages", name!);
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: `@openclaw/${name}`,
        type: "module",
        exports: { [`./${subpath}`]: `./dist/${subpath}.mjs` },
      }),
    );
    fs.writeFileSync(
      path.join(pkg, "dist", `${subpath}.mjs`),
      `export function ${symbol}() { throw new Error("No workers should need this operation"); }`,
    );
  }
  const worker = new URL("../../src/infra/worker-cpu.ts", import.meta.url);
  const loader = new URL("../../scripts/perf/team-shape-stress-loader.mjs", import.meta.url);
  const entry = path.join(dist, "entry.mjs");
  fs.writeFileSync(
    entry,
    `const {sampleTrackedWorkerMemory} = await import(${JSON.stringify(worker.href)});
     const builtImport = await import("@openclaw/normalization-core/record-coerce")
       .then(() => "incorrectly redirected", error => error.code);
     console.log(JSON.stringify({workers: sampleTrackedWorkerMemory().workerCount, builtImport}));`,
  );
  const { stdout } = await executeFile(
    resolveTestNodeExecPath(),
    ["--import", loader.href, entry],
    { cwd: root, timeout: 15_000 },
  );
  expect(JSON.parse(stdout)).toEqual({ workers: 0, builtImport: "ERR_MODULE_NOT_FOUND" });
});

it("loads each built entry's own package exports despite controller source aliases", async () => {
  const root = temporary.make("team-stress-build-roots-");
  fs.writeFileSync(path.join(root, "source.mjs"), 'export default "controller-source";');
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "stress-package": ["./source.mjs"] } } }),
  );
  const loader = new URL("../../scripts/perf/team-shape-stress-loader.mjs", import.meta.url);
  for (const side of ["base", "candidate"]) {
    const build = path.join(root, side);
    const pkg = path.join(build, "node_modules", "stress-package");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ type: "module", exports: "./compiled.mjs" }),
    );
    fs.writeFileSync(path.join(pkg, "compiled.mjs"), `export default ${JSON.stringify(side)};`);
    const entry = path.join(build, "entry.mjs");
    fs.writeFileSync(entry, 'import owner from "stress-package"; console.log(owner);');
    const { stdout } = await executeFile(
      resolveTestNodeExecPath(),
      ["--import", loader.href, entry],
      {
        cwd: root,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.json") },
        timeout: 15_000,
      },
    );
    expect(stdout.trim()).toBe(side);
  }
});

it("counts built policy preparation only inside the diagnostic measurement window", async () => {
  const root = temporary.make("team-stress-policy-counts-");
  fs.writeFileSync(
    path.join(root, "operator-model-policy-fixture.mjs"),
    `export function prepareOperatorModelPolicy(value) { prepareRefs(); return value; }
     export function restoreOperatorModelPolicySnapshot(value) { return value; }
     function prepareRefs() {}`,
  );
  const entry = path.join(root, "entry.mjs");
  fs.writeFileSync(
    entry,
    `import {prepareOperatorModelPolicy, restoreOperatorModelPolicySnapshot} from "./operator-model-policy-fixture.mjs";
     prepareOperatorModelPolicy("outside");
     process.emit("message", {channel: "team-shape-stress", action: "start"});
     if (prepareOperatorModelPolicy("inside") !== "inside") throw new Error("changed output");
     restoreOperatorModelPolicySnapshot({});
     process.emit("message", {channel: "team-shape-stress", action: "stop", output: ${JSON.stringify(root)}});`,
  );
  const loader = new URL("../../scripts/perf/team-shape-stress-loader.mjs", import.meta.url);
  await executeFile(resolveTestNodeExecPath(), ["--import", loader.href, entry], {
    cwd: root,
    env: { ...process.env, OPENCLAW_BENCH_OPERATOR_MODEL_POLICY_COUNTS: "1" },
    timeout: 15_000,
  });
  const result = JSON.parse(
    fs.readFileSync(path.join(root, "operator-model-policy-counts.json"), "utf8"),
  );
  expect(result.counts).toEqual({
    prepareOperatorModelPolicy: 1,
    restoreOperatorModelPolicySnapshot: 1,
    prepareRefs: 1,
    prepareSessionRowRecipient: 0,
  });
  expect(result.installed).toHaveLength(3);
});

it.each([false, true])(
  "counts main-isolate receipt restoration only when guarded assignment succeeds (candidate: %s)",
  async (candidate) => {
    const root = temporary.make("team-stress-receipt-counts-");
    const durable = path.join(root, "session-actor-durable-fixture.mjs");
    fs.writeFileSync(
      durable,
      `export function settle(committed, entryReference) {
        let result;
        result = committed;
        return result;
      }`,
    );
    const owner = path.join(root, "session-actor-memory-owner-fixture.mjs");
    fs.writeFileSync(
      owner,
      candidate
        ? `export function restoreSessionActorCommittedOutcome(outcome, reference) {
  const {receipt} = outcome;
  if (receipt.entryReference !== undefined) {
    if (!reference || receipt.entryReference !== reference.writeToken) throw new Error("token mismatch");
    receipt.postimage.entry = reference.entry;
    delete receipt.entryReference;
  }
  return outcome;
}`
        : "export const baseline = true;",
    );
    const entry = path.join(root, "entry.mjs");
    fs.writeFileSync(
      entry,
      `import {Worker} from "node:worker_threads";
       import {settle} from "./session-actor-durable-fixture.mjs";
       import * as owner from "./session-actor-memory-owner-fixture.mjs";
       const key = Symbol.for("openclaw.benchmark.session-actor-receipt-retention");
       const entry = Object.freeze({sessionId: "synthetic"});
       const reference = {writeToken: "match", entry};
       const outcome = (phase, append) => ({receipt: {phase, transcript: {append}}});
       const restore = (token, supplied = reference) => {
         const committed = {receipt: {entryReference: token, postimage: {}}};
         owner.restoreSessionActorCommittedOutcome(committed, supplied);
         return committed;
       };
       settle(outcome("appendTranscriptEvent", {}), reference);
       if (${candidate}) restore("match");
       let acknowledgments = 0;
       process.send = () => { acknowledgments++; return true; };
       process.emit("message", {channel: "team-shape-stress", action: "start"});
       const original = outcome("patch");
       if (settle(original, reference) !== original) throw new Error("changed result");
       settle(outcome("appendTranscriptEvent", {}), reference);
       settle(outcome("appendToolResult", {}));
       settle(outcome("appendToolResult", {initialEntry: {}}), reference);
       settle(outcome("appendToolResult"), reference);
       if (${candidate}) {
         if (restore("match").receipt.postimage.entry !== entry) throw new Error("changed entry");
         restore("match", {writeToken: "match"});
         restore(undefined);
         let refused = false;
         try { restore("wrong"); } catch { refused = true; }
         if (!refused) throw new Error("lost token refusal");
       }
       const worker = new Worker(
         'const {parentPort} = require("node:worker_threads"); import(' + JSON.stringify(new URL("./session-actor-durable-fixture.mjs", import.meta.url).href) + ').then(({settle}) => { settle({receipt:{phase:"appendTranscriptEvent",transcript:{append:{}}}}, {}); parentPort.postMessage({hasCounters: Symbol.for("openclaw.benchmark.session-actor-receipt-retention") in globalThis}); });',
         {eval: true}
       );
       const workerResult = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
       await worker.terminate();
       process.emit("message", {channel: "team-shape-stress", action: "stop", output: ${JSON.stringify(root)}});
       settle(outcome("appendTranscriptEvent", {}), reference);
       if (${candidate}) restore("match");
       console.log(JSON.stringify({acknowledgments, workerResult, enabled: globalThis[key].enabled,
         numericStateOnly: Object.values(globalThis[key]).every(value => typeof value === "number")}));`,
    );
    const preload = new URL(
      "../../scripts/perf/session-actor-receipt-retention-preload.mjs",
      import.meta.url,
    );
    const { stdout } = await executeFile(
      resolveTestNodeExecPath(),
      ["--import", preload.href, entry],
      {
        cwd: root,
        timeout: 15_000,
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      acknowledgments: 0,
      workerResult: { hasCounters: false },
      enabled: 0,
      numericStateOnly: true,
    });
    const result = JSON.parse(
      fs.readFileSync(path.join(root, "receipt-reference-counts.json"), "utf8"),
    );
    expect(result.counts).toEqual({
      committed: 5,
      committedWithHostPreimage: 4,
      appendShaped: 2,
      appendShapedWithHostPreimage: 1,
      appendInitializationOutcomes: 1,
      successfulRestores: candidate ? 2 : 0,
      successfulNonemptyRestores: candidate ? 1 : 0,
    });
    expect(result.installedHookCount).toBe(candidate ? 2 : 1);
    expect(result.installedHooks).toHaveLength(candidate ? 2 : 1);
    expect(result.installedHooks).toEqual(
      expect.arrayContaining([
        { hook: "committed-outcome", bundle: path.basename(durable) },
        ...(candidate ? [{ hook: "frozen-entry-restoration", bundle: path.basename(owner) }] : []),
      ]),
    );
    expect(result.endedAtEpochMs).toBeGreaterThanOrEqual(result.startedAtEpochMs);
    expect(result.scope).toContain("IPC span");
  },
);

it.each([
  [
    "session-actor-durable-bad.mjs",
    "export const unrelated = true;",
    "requires one result = committed; anchor",
  ],
  [
    "session-actor-durable-duplicate.mjs",
    "export function settle(committed, entryReference) { let result; result = committed; result = committed; return result; }",
    "requires one result = committed; anchor",
  ],
  [
    "session-actor-memory-owner-bad.mjs",
    "export function restoreSessionActorCommittedOutcome(outcome) { return outcome; }",
    "requires one receipt.postimage.entry = reference.entry; anchor",
  ],
])("refuses malformed receipt instrumentation in %s", async (bundle, source, error) => {
  const root = temporary.make("team-stress-receipt-bad-anchor-");
  const entry = path.join(root, bundle);
  fs.writeFileSync(entry, source);
  const preload = new URL(
    "../../scripts/perf/session-actor-receipt-retention-preload.mjs",
    import.meta.url,
  );
  await expect(
    executeFile(resolveTestNodeExecPath(), ["--import", preload.href, entry], {
      cwd: root,
      timeout: 15_000,
    }),
  ).rejects.toThrow(error);
});

it("refuses receipt counts when no committed-outcome hook was loaded", async () => {
  const root = temporary.make("team-stress-receipt-missing-hook-");
  const entry = path.join(root, "entry.mjs");
  fs.writeFileSync(
    entry,
    `process.emit("message", {channel:"team-shape-stress", action:"start"});
     process.emit("message", {channel:"team-shape-stress", action:"stop", output:${JSON.stringify(root)}});`,
  );
  const preload = new URL(
    "../../scripts/perf/session-actor-receipt-retention-preload.mjs",
    import.meta.url,
  );
  await expect(
    executeFile(resolveTestNodeExecPath(), ["--import", preload.href, entry], {
      cwd: root,
      timeout: 15_000,
    }),
  ).rejects.toThrow("requires one committed hook and at most one restore hook");
  expect(fs.existsSync(path.join(root, "receipt-reference-counts.json"))).toBe(false);
});

it("requires ten-minute evidence windows and marks explicit short runs as smoke", () => {
  const options = parseStressOptions(["--output", "/unused"]);
  expect(options).toMatchObject({
    durationMs: 600_000,
    smoke: false,
    clients: 65,
    pairs: 2,
    aaPairs: 0,
    pollMs: 25_000,
    listWeight: 16,
    roundMs: 60_000,
    churnMs: 6_000,
    operatorModelPolicy: false,
    workerHeapSnapshot: false,
  });
  expect(parseStressOptions(["--output", "/unused", "--smoke-seconds", "1"])).toMatchObject({
    durationMs: 1_000,
    smoke: true,
  });
  expect(parseStressOptions(["--output", "/unused", "--operator-model-policy"])).toMatchObject({
    operatorModelPolicy: true,
  });
  expect(parseStressOptions(["--output", "/unused", "--mode", "retention"])).toMatchObject({
    mode: "retention",
  });
  expect(parseStressOptions(["--output", "/unused", "--worker-heap-snapshot"])).toMatchObject({
    workerHeapSnapshot: true,
  });
  expect(
    parseStressOptions([
      "--output",
      "/unused",
      "--base",
      "/base",
      "--pairs",
      "3",
      "--aa-pairs",
      "2",
    ]),
  ).toMatchObject({ pairs: 3, aaPairs: 2 });
  for (const args of [
    [],
    ["--output"],
    ["--output", "/unused", "--unknown"],
    ["--output", "/unused", "--minutes", "9"],
    ["--output", "/unused", "--minutes", "10.5"],
    ["--output", "/unused", "--minutes", "Infinity"],
    ["--output", "/unused", "--clients", "1"],
    ["--output", "/unused", "--runs", "0"],
    ["--output", "/unused", "--plugins", "3"],
    ["--output", "/unused", "--plugins", "41"],
    ["--output", "/unused", "--list-weight", "0"],
    ["--output", "/unused", "--list-weight", "65"],
    ["--output", "/unused", "--pairs", "0"],
    ["--output", "/unused", "--aa-pairs", "1"],
    ["--output", "/unused", "--base", "/base", "--pairs", "1", "--aa-pairs", "2"],
    ["--output", "/unused", "--mode", "invalid"],
    ["--output", "/unused", "--port", "18789"],
    ["--output", "/unused", "--port", "65536"],
  ]) {
    expect(() => parseStressOptions(args), JSON.stringify(args)).toThrow();
  }
});

it.each(["timing", "allocation", "retention"])(
  "records real main-isolate %s evidence and settles telemetry once",
  async (mode) => {
    const output = temporary.make("team-stress-telemetry-");
    const telemetryModule = new URL(
      "../../scripts/perf/team-shape-stress-telemetry.ts",
      import.meta.url,
    );
    await executeFile(
      resolveTestNodeExecPath(),
      [
        "--input-type=module",
        "--eval",
        `import { setTimeout as delay } from 'node:timers/promises';
       const { startTeamStressTelemetry } = await import(${JSON.stringify(telemetryModule.href)});
       const stop = await startTeamStressTelemetry({output: ${JSON.stringify(output)}, allocations: ${mode !== "timing"}, retention: ${mode === "retention"}, intervalMs: 100});
       await delay(250);
       await Promise.all([stop(), stop()]);`,
      ],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 15_000 },
    );
    const summary = JSON.parse(fs.readFileSync(path.join(output, "stress-telemetry.json"), "utf8"));
    const windows = fs
      .readFileSync(path.join(output, "stress-minutes.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(summary.mode).toBe(mode === "timing" ? "untraced-timing" : `${mode}-diagnostic`);
    expect(summary.pid).not.toBe(process.pid);
    expect(summary.durationMs).toBeGreaterThanOrEqual(200);
    expect(summary.eventLoop.count).toBeGreaterThan(0);
    expect(summary.mainThreadCpuMs).toBeGreaterThanOrEqual(0);
    expect(summary.lastSample.memory.heapUsed).toBeGreaterThan(0);
    expect(summary.lastSample.memory.rss).toBeGreaterThan(0);
    expect(summary.initialMemory.heapUsed).toBeGreaterThan(0);
    expect(
      summary.initialHeapSpaces.some(
        (space: { space_name: string }) => space.space_name === "old_space",
      ),
    ).toBe(true);
    expect(summary.windows).toBe(windows.length);
    expect(windows.filter((window) => window.partial)).toHaveLength(1);
    expect(windows.at(-1).partial).toBe(true);
    expect(windows.every((window) => window.sampledAllocatedBytes === null)).toBe(
      mode !== "allocation",
    );
    expect(fs.existsSync(path.join(output, "stress-allocation.heapprofile"))).toBe(
      mode === "allocation",
    );
    expect(fs.existsSync(path.join(output, "stress-retention.heapprofile"))).toBe(
      mode === "retention",
    );
    expect(fs.existsSync(path.join(output, "stress-retained.heapsnapshot"))).toBe(
      mode === "retention",
    );
    if (mode === "timing") {
      expect(summary.samplingOptions).toBeNull();
    } else {
      expect(summary.samplingOptions).toMatchObject({
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: mode === "allocation",
      });
    }
    if (mode === "retention") {
      expect(summary.sampledAllocatedBytes).toBeNull();
      expect(summary.sampledSurvivorBytes).toBeGreaterThanOrEqual(0);
      // No periodic profile materialization should perturb survivor measurements.
      expect(windows.every((window) => window.sampledSurvivorBytes === null)).toBe(true);
      const retained = JSON.parse(
        fs.readFileSync(path.join(output, "stress-retention.json"), "utf8"),
      );
      expect(retained.measuredWindowEndedAtEpochMs).toBe(summary.endedAtEpochMs);
      expect(retained.beforeCollection.atEpochMs).toBeGreaterThanOrEqual(summary.endedAtEpochMs);
      expect(retained.afterCollection.atEpochMs).toBeGreaterThanOrEqual(
        retained.beforeCollection.atEpochMs,
      );
      expect(retained.afterSnapshot.atEpochMs).toBeGreaterThanOrEqual(
        retained.afterCollection.atEpochMs,
      );
      const snapshot = JSON.parse(
        fs.readFileSync(path.join(output, retained.heapSnapshot), "utf8"),
      );
      expect(snapshot.snapshot.meta.node_fields).toContain("self_size");
      expect(snapshot.nodes.length).toBeGreaterThan(0);
      expect(snapshot.edges.length).toBeGreaterThan(0);
    }
  },
);

it("compares swapped pairs without mixing A/A controls or averaging tiny-base percentages", () => {
  const run = (side: StressRun["side"], pair: number, cpu: number): StressRun => ({
    resultDir: "/synthetic",
    side,
    pair,
    mode: "timing",
    smoke: false,
    durationMs: 600_000,
    metrics: { mainThreadCpuPercent: cpu, zeroCost: 0, missingCost: null },
    rpc: {},
    gc: {},
    stalls: { count: 0, totalMs: 0, maxMs: 0 },
    workerHeaps: undefined,
    rpcMinutes: [],
    nativeOldGenerationSamples: [],
    memoryScope: "synthetic comparison fixture",
  });
  const rows = compareStressRuns([
    run("base", 1, 1),
    run("candidate", 1, 3),
    run("candidate", 2, 80),
    run("base", 2, 100),
    { ...run("base", 1, 7), control: true },
    { ...run("candidate", 1, 9), control: true },
  ]);
  const cpu = rows.find((row) => !row.control && row.metric === "mainThreadCpuPercent");
  expect(cpu).toMatchObject({
    base: 50.5,
    candidate: 41.5,
    absolute: -9,
    pairs: 2,
    pairedDeltas: [2, -20],
  });
  expect(cpu?.percent).toBeCloseTo((-9 / 50.5) * 100);
  expect(rows.filter((row) => row.metric === "mainThreadCpuPercent")).toHaveLength(2);
  expect(rows.find((row) => row.control && row.metric === "mainThreadCpuPercent")).toMatchObject({
    base: 7,
    candidate: 9,
    absolute: 2,
    pairs: 1,
    pairedDeltas: [2],
  });
  expect(rows.find((row) => row.metric === "zeroCost")).toMatchObject({
    base: 0,
    absolute: 0,
    percent: null,
  });
  expect(rows.find((row) => row.metric === "missingCost")).toMatchObject({
    base: null,
    candidate: null,
    absolute: null,
    percent: null,
    pairs: 0,
    context: "inconclusive: missing paired metric",
  });
});

it("keeps partial worker evidence without comparing incomplete heap totals", () => {
  const capture = (side: StressRun["side"], reason?: string) => {
    const resultDir = temporary.make("team-stress-worker-census-");
    const workerMemoryMissing = reason ? [{ script: "fixture-worker", threadId: 2, reason }] : [];
    const workers = {
      workerCount: 2,
      workerHeapSampledCount: reason ? 1 : 2,
      workerHeapUsedBytes: (reason ? 1 : 10) * 1024 ** 2,
      workerArrayBuffersSampledCount: 1,
      workerMemoryCoverage: "partial",
      workerMemoryMissing,
    };
    fs.writeFileSync(
      path.join(resultDir, "result.json"),
      JSON.stringify({
        completedTurns: 1,
        teamStress: { committedWrites: 1, prometheusScrapes: 1, rpcMinutes: [] },
        memorySamples: [{ collectedGarbage: false, resources: { workers } }],
        samples: [
          {
            toolCalls: 1,
            toolResults: 1,
            rpc: Object.fromEntries(
              [
                "sessions.list",
                "chat.history",
                "chat.startup",
                "sessions.diff",
                "connect",
                "chat.inject",
              ].map((method) => [method, { latenciesMs: [1] }]),
            ),
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(resultDir, "stress-telemetry.json"),
      JSON.stringify({
        mode: "untraced-timing",
        durationMs: 600_000,
        mainThreadCpuPercent: 1,
        sampledAllocatedBytesPerSecond: null,
        gc: {},
        eventLoop: { count: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 },
        stalls: { count: 0, totalMs: 0, maxMs: 0 },
        lastSample: { memory: { rss: 1024 ** 2, heapUsed: 1024 ** 2 } },
      }),
    );
    return summarizeStressRun({ resultDir, side, pair: 1, mode: "timing", smoke: false });
  };
  const base = capture("base");
  expect(base.metrics.workerHeapMiB).toBe(10);
  for (const reason of ["pending", "stale", "unavailable"]) {
    const candidate = capture("candidate", reason);
    expect(candidate.workerHeaps?.workerHeapUsedBytes).toBe(1024 ** 2);
    expect(candidate.metrics.workerMemoryMissing).toBe(1);
    expect(candidate.metrics.workerHeapMiB).toBeNull();
    expect(
      compareStressRuns([base, candidate]).find((row) => row.metric === "workerHeapMiB"),
    ).toMatchObject({
      absolute: null,
      percent: null,
      pairs: 0,
      context: "inconclusive: missing paired metric",
    });
  }
});
