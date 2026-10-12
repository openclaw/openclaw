import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as tick } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import { isConstrainedCiCheckHost } from "../../scripts/lib/local-check-runtime.mts";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import {
  createControlledWorkerCompiler,
  createWorkerArtifactTest,
  fixtureFileBeforeSettlement,
  writeFixture,
} from "./vitest-worker-artifacts.test-support.js";

const it = createWorkerArtifactTest();
let receipts: FixtureReceiptChannel;
it.beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
it.afterAll(() => receipts.close());
const root = process.cwd();
const command = ["--import", "tsx", "scripts/ci-run-node-test-shard.mts"];
type Observation = {
  generation: string;
  pid: number;
  parent: number;
  planner: number;
  group: string;
  inputDigest: string;
  includeFile: string;
};
const generationDirectory = (generation: string) => fileURLToPath(new URL("../../", generation));

// Native grandchildren expose no harness-owned close event. Missing-claim errors can suppress
// group-end output, and Darwin managed joins can precede orphan-zombie reaping.
async function waitForBorrowerExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isProcessAlive(pid)) {
      await tick(10, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`process still alive: ${pid}`, { cause: error });
    }
    throw error;
  }
}

function createCiProbe(
  directory: string,
  retain = false,
  generationClaim?: "pending" | "released",
) {
  const observationsFile = path.join(directory, "observations.jsonl");
  const release = path.join(directory, "release");
  const ready = path.join(directory, "ready");
  const startFirst = path.join(directory, "start-first");
  const firstReady = path.join(directory, "first-ready");
  // Identify the group planner before either thread or fork leaves inherit its environment.
  const plannerPreload = writeFixture(
    directory,
    "planner-preload.mjs",
    `
    import path from 'node:path';
    import { isMainThread } from 'node:worker_threads';
    const planner = ${JSON.stringify(path.join(root, "scripts/test-projects.mts"))};
    if (isMainThread && [process.argv[1], process.argv[3]].some(arg => arg && path.resolve(arg) === planner)) {
      process.env.OPENCLAW_FIXTURE_PLANNER_PID = String(process.pid);
    }`,
  );
  const probe = writeFixture(
    directory,
    "child.test.ts",
    `
    ${fixtureReceiptClientSource(receipts.endpoint)}
    import fs from 'node:fs';
    import { createHash } from 'node:crypto';
    import { fileURLToPath } from 'node:url';
    import { it, expect } from 'vitest';
    import { runtimeProcessEntrypoints } from ${JSON.stringify(path.join(root, "src/infra/runtime-process-entrypoints.ts"))};
    import { resolveRuntimeWorkerUrl } from ${JSON.stringify(path.join(root, "src/infra/runtime-worker-url.ts"))};
    import { findVitestResourceOwner } from ${JSON.stringify(path.join(root, "scripts/lib/vitest-resource-ownership.mts"))};
    const generation = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
    const prepared = fs.existsSync(generation);
    const waitForSignal = filename => new Promise(resolve => {
      const check = () => {
        if (fs.existsSync(filename) || fs.existsSync(${JSON.stringify(release)})) {
          clearInterval(poll); resolve();
        }
      };
      const poll = setInterval(check, 50);
      check();
    });
    it('borrows its CI-owned compiled worker during collection', async () => {
      expect(generation.pathname.endsWith('/dist/infra/sqlite-readonly-location.worker.js')).toBe(true);
      expect(prepared).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(new URL('../../manifest.json', generation), 'utf8'));
      const group = process.env.OPENCLAW_VITEST_SHARD_NAME;
      if (${retain} && group === 'first-group') {
        await waitForSignal(${JSON.stringify(startFirst)});
      }
      fs.appendFileSync(${JSON.stringify(observationsFile)}, JSON.stringify({
        generation: generation.href, pid: process.pid, parent: process.ppid, group,
        planner: Number(process.env.OPENCLAW_FIXTURE_PLANNER_PID),
        includeFile: process.env.OPENCLAW_VITEST_INCLUDE_FILE,
        inputDigest: createHash('sha256').update(JSON.stringify(manifest.inputs)).digest('hex'),
      })+'\\n');
      if (${retain}) {
        if (group === 'first-group') {
          try {
            if (${Boolean(generationClaim)}) {
              const owner = findVitestResourceOwner(fileURLToPath(new URL('.', generation)));
              expect(owner?.root).toBe(fs.realpathSync(new URL('../../', generation)));
              const releaseClaim = owner.claim();
              if (${generationClaim === "released"}) releaseClaim();
            } else {
              // Missing release evidence must survive this successful leaf's process exit.
              findVitestResourceOwner().claim();
            }
          } finally {
            fs.writeFileSync(${JSON.stringify(firstReady)}, 'ready');
            sendReceipt(${JSON.stringify(firstReady)}, 'written');
          }
          if (${generationClaim === "released"}) {
            throw new Error('ordinary failure after releasing generation claim');
          }
        } else {
          fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
          sendReceipt(${JSON.stringify(ready)}, 'written');
          await waitForSignal(${JSON.stringify(release)});
          fs.accessSync(generation);
          fs.writeFileSync(${JSON.stringify(ready + ".read")}, 'read after sibling exit');
        }
      }
    });`,
  );
  return {
    probe,
    plannerPreload,
    observationsFile,
    release,
    ready,
    startFirst,
    firstReady,
    read: (): Observation[] =>
      fs
        .readFileSync(observationsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

function ciEnv(probe: string, parallelism: number, repeatSpec = false): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Nested groups own their cache slots; a parent cache leaf forces serial admission.
    OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: "",
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "",
    OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: String(parallelism),
    OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: "[]",
    OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
      ["first-group", "second-group"].map((shard_name, index) => ({
        // A second finite spec exercises later loans over the same parent's IPC channel.
        configs: [
          "test/vitest/vitest.tooling.config.ts",
          ...(repeatSpec && index === 0 ? ["test/vitest/vitest.tooling-isolated.config.ts"] : []),
        ],
        includePatterns: [probe],
        shard_name,
      })),
    ),
    OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: "",
    OPENCLAW_NODE_TEST_TARGETS_JSON: "[]",
    OPENCLAW_VITEST_MAX_WORKERS: "1",
  };
}

// Sharing needs POSIX group joins; the false-capability row simulates Windows ownership only.
it.runIf(process.platform !== "win32").for([
  { parallelism: 1, shared: true },
  { parallelism: 2, shared: true },
  { parallelism: 2, shared: false },
])(
  "owns real CI group generations (parallelism=$parallelism, shared=$shared)",
  ({ parallelism, shared }, { workerArtifacts, signal }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const { node } = workerArtifacts.createFixtureCommands();
      const directory = workerArtifacts.fixtureDirectory();
      const fixture = createCiProbe(directory);
      const temp = path.join(directory, "tmp");
      fs.mkdirSync(temp);
      const groupOwner = pathToFileURL(path.join(root, "scripts/vitest-process-group.mts")).href;
      const capability = shared
        ? undefined
        : writeFixture(
            directory,
            "capability.mjs",
            `import {registerHooks} from 'node:module';
        registerHooks({load(url, context, nextLoad) {
          if (url === ${JSON.stringify(groupOwner)}) return {
            format:'module',shortCircuit:true,
            source:${JSON.stringify(`export * from ${JSON.stringify(groupOwner + "?fixture-original")}; export function shouldUseDetachedVitestProcessGroup() { return false; }`)},
          };
          return nextLoad(url, context);
        }});`,
          );
      const env = {
        ...ciEnv(fixture.probe, parallelism, parallelism === 1),
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(fixture.plannerPreload).href}`,
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
      };
      const controlled =
        shared && parallelism === 2 ? undefined : createControlledWorkerCompiler(directory, env);
      try {
        const result = await node(
          capability ? ["--import", "tsx", "--import", capability, command.at(-1)!] : command,
          root,
          controlled?.env ?? env,
        );
        expect(result.code, result.stderr + result.stdout).toBe(0);
        if (controlled) {
          const compilerReceipts = controlled.read();
          console.log("Controlled compiler receipts", JSON.stringify(compilerReceipts));
          expect(compilerReceipts).toHaveLength(shared ? 1 : 2);
          expect(
            new Set(
              compilerReceipts.map(({ pid, processStartTime }) => `${pid}:${processStartTime}`),
            ).size,
          ).toBe(compilerReceipts.length);
          for (const receipt of compilerReceipts) {
            expect(receipt).toMatchObject({
              processStartTime: expect.any(Number),
              isMainThread: true,
            });
          }
        }
        const observations = fixture.read();
        const borrowerCount = parallelism === 1 ? 3 : 2;
        expect(observations).toHaveLength(borrowerCount);
        expect(new Set(observations.map(({ pid }) => pid)).size).toBe(borrowerCount);
        expect(new Set(observations.map(({ planner }) => planner)).size).toBe(2);
        for (const group of ["first-group", "second-group"]) {
          const members = observations.filter((observation) => observation.group === group);
          expect(members).toHaveLength(group === "first-group" && parallelism === 1 ? 2 : 1);
          expect(new Set(members.map(({ planner }) => planner)).size).toBe(1);
          expect(members[0]!.planner).toBeGreaterThan(0);
        }
        expect(new Set(observations.map(({ inputDigest }) => inputDigest)).size).toBe(1);
        const generations = observations.map(({ generation }) => generation);
        console.log("CI generation observations", JSON.stringify(observations));
        expect(new Set(generations).size).toBe(shared ? 1 : 2);
        expect((result.stdout + result.stderr).match(/\[vitest-workers\] prepared/g)).toHaveLength(
          shared ? 1 : 2,
        );
        expect(result.stdout).toContain("[shard:first-group] end (exit 0)");
        expect(result.stdout).toContain("[shard:second-group] end (exit 0)");
        for (const generation of generations) {
          expect(fs.existsSync(generationDirectory(generation))).toBe(false);
        }
        for (const { includeFile } of observations) {
          expect(fs.existsSync(path.dirname(includeFile))).toBe(!shared);
          if (!shared) {
            expect(result.stderr).toContain(`[shard:cache] retained ${path.dirname(includeFile)}`);
          }
        }
      } finally {
        const observations = fs.existsSync(fixture.observationsFile) ? fixture.read() : [];
        // Shared group joins prove extinction. The non-detached fixture instead uses node()'s
        // managed join, which can accept Darwin zombies before the kernel reaps their PIDs.
        for (const { pid, parent } of observations) {
          if (!shared && process.platform === "darwin") {
            await Promise.all([
              waitForBorrowerExit(pid, signal),
              waitForBorrowerExit(parent, signal),
            ]);
          }
          expect(isProcessAlive(pid), `process still alive: ${pid}`).toBe(false);
          expect(isProcessAlive(parent), `process still alive: ${parent}`).toBe(false);
        }
        for (const run of new Set(observations.map(({ generation }) => generation))) {
          fs.rmSync(generationDirectory(run), { recursive: true, force: true });
        }
        for (const scratch of new Set(
          observations.map(({ includeFile }) => path.dirname(includeFile)),
        )) {
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      }
    }),
);

it
  .runIf(
    process.platform !== "win32" &&
      !isConstrainedCiCheckHost({
        logicalCpuCount: os.availableParallelism(),
        totalMemoryBytes: os.totalmem(),
      }),
  )
  .for([
    {
      name: "retains a shared generation after missing nested release evidence while a sibling borrows it",
      claim: "temporary",
    },
    {
      name: "retains a shared generation after a successful borrower leaves its generation claim pending",
      claim: "pending",
    },
    {
      name: "removes a shared generation after a borrower releases its generation claim and fails normally",
      claim: "released",
    },
  ] as const)("$name", ({ claim }, { workerArtifacts, signal }) =>
  workerArtifacts.fixtureLifetime.run(async () => {
    const { node } = workerArtifacts.createFixtureCommands();
    const directory = workerArtifacts.fixtureDirectory();
    const fixture = createCiProbe(directory, true, claim === "temporary" ? undefined : claim);
    const env = ciEnv(fixture.probe, 2);
    // Deliberate TMP claims stay inside this fixture, never the enclosing test's owner.
    const temp = path.join(directory, "tmp");
    fs.mkdirSync(temp);
    Object.assign(env, { TMPDIR: temp, TMP: temp, TEMP: temp });
    const controlled = createControlledWorkerCompiler(directory, env);
    const running = node(command, root, controlled.env);
    try {
      await withinTest(fixtureFileBeforeSettlement(receipts, fixture.ready, running), signal);
      // Hold first-group until its sibling is borrowing, then join its own receipt.
      fs.writeFileSync(fixture.startFirst, "start");
      await withinTest(fixtureFileBeforeSettlement(receipts, fixture.firstReady, running), signal);
      const observations = fixture.read();
      const first = observations.find(({ group }) => group === "first-group")!;
      const second = observations.find(({ group }) => group === "second-group")!;
      expect(observations).toHaveLength(2);
      expect(new Set(observations.map(({ generation }) => generation)).size).toBe(1);
      await Promise.all([
        waitForBorrowerExit(first.pid, signal),
        waitForBorrowerExit(first.parent, signal),
      ]);
      expect(isProcessAlive(second.pid)).toBe(true);
      expect(fs.existsSync(generationDirectory(first.generation))).toBe(true);
      expect(fs.existsSync(first.includeFile)).toBe(true);
      fs.writeFileSync(fixture.release, "finish");
      const result = await withinTest(running, signal);
      const compilerReceipts = controlled.read();
      expect(compilerReceipts).toHaveLength(1);
      console.log("Controlled compiler receipts", JSON.stringify(compilerReceipts));
      expect(result.code).not.toBe(0);
      if (claim === "temporary") {
        expect(result.stdout + result.stderr).toContain("retained temporary namespace");
        expect(result.stderr).toContain("borrower join failed");
      } else {
        expect(result.code).toBe(1);
        expect(result.stdout + result.stderr).not.toContain("retained temporary namespace");
        expect(result.stdout).toContain(
          `[shard:first-group] end (exit ${claim === "released" ? 1 : 0})`,
        );
        expect(result.stdout).toContain("[shard:second-group] end (exit 0)");
        if (claim === "pending") {
          expect(result.stderr).toContain("Unreleased Vitest resource claim:");
          expect(result.stderr).toContain("fixture resource join failed");
        } else {
          expect(result.stdout + result.stderr).toContain(
            "ordinary failure after releasing generation claim",
          );
          expect(result.stderr).not.toContain("[vitest-workers] retaining");
        }
      }
      expect(fs.readFileSync(fixture.ready + ".read", "utf8")).toBe("read after sibling exit");
      expect(fs.existsSync(generationDirectory(first.generation))).toBe(claim !== "released");
      expect(fs.existsSync(path.dirname(first.includeFile))).toBe(claim !== "released");
    } finally {
      fs.writeFileSync(fixture.release, "finish");
      await running;
      const observations = fs.existsSync(fixture.observationsFile) ? fixture.read() : [];
      // The CI command finishes only after both group completions and worker-run disposal.
      for (const { pid, parent } of observations) {
        expect(isProcessAlive(pid), `process still alive: ${pid}`).toBe(false);
        expect(isProcessAlive(parent), `process still alive: ${parent}`).toBe(false);
      }
      for (const run of new Set(observations.map(({ generation }) => generation))) {
        fs.rmSync(generationDirectory(run), { recursive: true, force: true });
      }
      for (const scratch of new Set(
        observations.map(({ includeFile }) => path.dirname(includeFile)),
      )) {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  }),
);
