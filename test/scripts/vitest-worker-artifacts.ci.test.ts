import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import { isConstrainedCiCheckHost } from "../../scripts/lib/local-check-runtime.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";
import {
  createControlledWorkerCompiler,
  createWorkerArtifactTest,
  fixtureFileBeforeSettlement,
  inWorkerArtifactFixture,
  readFixtureLines,
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
  group: string;
  includeFile: string;
};
const generationDirectory = (generation: string) => fileURLToPath(new URL("../../", generation));
const distinct = (values: readonly unknown[]) => new Set(values).size;

function observationPaths(observation: Observation) {
  return [generationDirectory(observation.generation), path.dirname(observation.includeFile)];
}

function cleanObservations(observations: Observation[], remove: boolean) {
  for (const processId of observations.flatMap(({ pid, parent }) => [pid, parent])) {
    expect(isProcessAlive(processId), `process still alive: ${processId}`).toBe(false);
  }
  if (remove) {
    for (const directory of new Set(observations.flatMap(observationPaths))) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
  const probe = writeFixture(
    directory,
    "child.test.ts",
    `
    ${fixtureReceiptClientSource(receipts.endpoint)}
    import fs from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import { setTimeout as tick } from 'node:timers/promises';
    import { it, expect } from 'vitest';
    import { runtimeProcessEntrypoints } from ${JSON.stringify(path.join(root, "src/infra/runtime-process-entrypoints.ts"))};
    import { resolveRuntimeWorkerUrl } from ${JSON.stringify(path.join(root, "src/infra/runtime-worker-url.ts"))};
    import { findVitestResourceOwner } from ${JSON.stringify(path.join(root, "scripts/lib/vitest-resource-ownership.mts"))};
    const generation = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
    const prepared = fs.existsSync(generation);
    const waitForSignal = async filename => {
      while (!fs.existsSync(filename) && !fs.existsSync(${JSON.stringify(release)})) {
        await tick(50);
      }
    };
    it('borrows its CI-owned compiled worker during collection', async () => {
      expect(prepared).toBe(true);
      const group = process.env.OPENCLAW_VITEST_SHARD_NAME;
      if (${retain} && group === 'first-group') {
        await waitForSignal(${JSON.stringify(startFirst)});
      }
      fs.appendFileSync(${JSON.stringify(observationsFile)}, JSON.stringify({
        generation: generation.href, pid: process.pid, parent: process.ppid, group,
        includeFile: process.env.OPENCLAW_VITEST_INCLUDE_FILE,
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
    release,
    ready,
    startFirst,
    firstReady,
    read: (): Observation[] =>
      fs.existsSync(observationsFile) ? readFixtureLines(observationsFile) : [],
  };
}

function ciEnv(probe: string, parallelism: number, repeatSpec = false): NodeJS.ProcessEnv {
  const temp = path.join(path.dirname(probe), "tmp");
  fs.mkdirSync(temp);
  return {
    ...testRunnerFixtureEnv(),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
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
  ({ parallelism, shared }, { workerArtifacts, signal, onTestFinished }) =>
    inWorkerArtifactFixture(
      { workerArtifacts, signal, onTestFinished },
      async ({ node, directory }) => {
        const fixture = createCiProbe(directory);
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
        const env = ciEnv(fixture.probe, parallelism, parallelism === 1);
        const controlled =
          shared && parallelism === 2 ? undefined : createControlledWorkerCompiler(directory, env);
        try {
          const { code, stdout, stderr } = await node(
            capability ? ["--import", "tsx", "--import", capability, command.at(-1)!] : command,
            root,
            controlled?.env ?? env,
          );
          expect(code, stderr + stdout).toBe(0);
          if (controlled) {
            const entries = controlled.read();
            expect(entries).toHaveLength(shared ? 1 : 2);
          }
          const observations = fixture.read();
          const borrowerCount = parallelism === 1 ? 3 : 2;
          expect(observations).toHaveLength(borrowerCount);
          expect(distinct(observations.map(({ pid }) => pid))).toBe(borrowerCount);
          for (const group of ["first-group", "second-group"]) {
            const members = observations.filter((observation) => observation.group === group);
            expect(members).toHaveLength(group === "first-group" && parallelism === 1 ? 2 : 1);
          }
          const generations = observations.map(({ generation }) => generation);
          expect(distinct(generations)).toBe(shared ? 1 : 2);
          for (const generation of generations) {
            expect(fs.existsSync(generationDirectory(generation))).toBe(false);
          }
          for (const { includeFile } of observations) {
            expect(fs.existsSync(path.dirname(includeFile))).toBe(!shared);
          }
        } finally {
          const observations = fixture.read();
          // Shared group joins prove extinction. The non-detached fixture instead uses node()'s
          // managed join, which can accept Darwin zombies before the kernel reaps their PIDs.
          for (const { pid, parent } of observations) {
            if (!shared && process.platform === "darwin") {
              await Promise.all([waitForDead(pid, signal), waitForDead(parent, signal)]);
            }
          }
          cleanObservations(observations, true);
        }
      },
    ),
);

it
  .runIf(
    process.platform !== "win32" &&
      !isConstrainedCiCheckHost({
        logicalCpuCount: os.availableParallelism(),
        totalMemoryBytes: os.totalmem(),
      }),
  )
  .for(["temporary", "pending", "released"] as const)(
  "settles shared generations with a %s claim while a sibling borrows",
  async (claim, { workerArtifacts, signal }) => {
    const deliberatelyRetained = claim !== "released";
    const retainedRoot = deliberatelyRetained
      ? fs.mkdtempSync(path.join(root, ".artifacts/worker-retention-proof-"))
      : undefined;
    if (retainedRoot) {
      createVitestResourceOwner(retainedRoot);
    }
    const lifetime = retainedRoot
      ? createFixtureLifetime(retainedRoot)
      : workerArtifacts.fixtureLifetime;
    try {
      await lifetime.run(async () => {
        const { node } = workerArtifacts.createFixtureCommands();
        const directory = retainedRoot
          ? lifetime.createTempDir("worker proof-", retainedRoot)
          : workerArtifacts.fixtureDirectory();
        const fixture = createCiProbe(directory, true, claim === "temporary" ? undefined : claim);
        const env = ciEnv(fixture.probe, 2);
        const controlled = createControlledWorkerCompiler(directory, env);
        const running = retainedRoot
          ? lifetime.track(
              runNodeScript(command, controlled.env, undefined, {
                cwd: root,
                signal,
                maxBuffer: 2 * 1024 * 1024,
                requireProcessTreeExit: true,
              }).then((result) => ({ ...result, code: result.status })),
            )
          : node(command, root, controlled.env);
        try {
          await withinTest(fixtureFileBeforeSettlement(receipts, fixture.ready, running), signal);
          // Hold first-group until its sibling is borrowing, then join its own receipt.
          fs.writeFileSync(fixture.startFirst, "start");
          await withinTest(
            fixtureFileBeforeSettlement(receipts, fixture.firstReady, running),
            signal,
          );
          const observations = fixture.read();
          const first = observations.find(({ group }) => group === "first-group")!;
          const second = observations.find(({ group }) => group === "second-group")!;
          expect(observations).toHaveLength(2);
          expect(distinct(observations.map(({ generation }) => generation))).toBe(1);
          await Promise.all([waitForDead(first.pid, signal), waitForDead(first.parent, signal)]);
          expect(isProcessAlive(second.pid)).toBe(true);
          expect(fs.existsSync(generationDirectory(first.generation))).toBe(true);
          expect(fs.existsSync(first.includeFile)).toBe(true);
          fs.writeFileSync(fixture.release, "finish");
          const { code, stdout, stderr, error } = await withinTest(running, signal);
          const output = stdout + stderr;
          expect(controlled.read()).toHaveLength(1);
          expect(code).toBe(deliberatelyRetained ? null : 1);
          if (deliberatelyRetained) {
            expect(error).toMatchObject({
              code: "EPROCESSGROUP_CLEANUP_FAILED",
              processTreeState: "indeterminate",
              cause: { message: "Managed cleanup owner reported unjoined work" },
            });
          }
          if (claim === "released") {
            expect(output).toContain("ordinary failure after releasing generation claim");
          }
          expect(fs.readFileSync(fixture.ready + ".read", "utf8")).toBe("read after sibling exit");
          expect(observationPaths(first).map(fs.existsSync)).toEqual([
            deliberatelyRetained,
            deliberatelyRetained,
          ]);
        } finally {
          fs.writeFileSync(fixture.release, "finish");
          await running;
          const observations = fixture.read();
          cleanObservations(observations, !deliberatelyRetained);
        }
      });
    } finally {
      if (retainedRoot) {
        // Missing handoff evidence cannot prove detached writers stopped. Keep the
        // isolated negative fixture; its failure must not retain the enclosing test.
        await expect(lifetime.cleanup()).rejects.toThrow("Fixture cleanup unverified");
        expect(fs.existsSync(retainedRoot)).toBe(true);
      }
    }
  },
);
