import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import { isConstrainedCiCheckHost } from "../../scripts/lib/local-check-runtime.mts";
import { isProcessAlive, waitForDead, waitForFixtureFile } from "../helpers/process-wait.js";
import {
  createControlledWorkerCompiler,
  createWorkerArtifactTest,
  writeFixture,
} from "./vitest-worker-artifacts.test-support.js";

const it = createWorkerArtifactTest();
const root = process.cwd();
const command = ["--import", "tsx", "scripts/ci-run-node-test-shard.mts"];
type Observation = {
  generation: string;
  pid: number;
  parent: number;
  group: string;
  inputDigest: string;
  includeFile: string;
};
const generationDirectory = (generation: string) => fileURLToPath(new URL("../../", generation));

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
          }
          if (${generationClaim === "released"}) {
            throw new Error('ordinary failure after releasing generation claim');
          }
        } else {
          fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
          await waitForSignal(${JSON.stringify(release)});
          fs.accessSync(generation);
          fs.writeFileSync(${JSON.stringify(ready + ".read")}, 'read after sibling exit');
        }
      }
    });`,
  );
  return {
    probe,
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
  ({ parallelism, shared }, { workerArtifacts }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const { node } = workerArtifacts.createFixtureCommands();
      const directory = workerArtifacts.fixtureDirectory();
      const fixture = createCiProbe(directory);
      const temp = path.join(directory, "tmp");
      if (!shared) {
        fs.mkdirSync(temp);
      }
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
        // An intentionally unavailable join capability retains claims inside this fixture.
        ...(!shared ? { TMPDIR: temp, TMP: temp, TEMP: temp } : {}),
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
          const receipts = controlled.read();
          console.log("Controlled compiler receipts", JSON.stringify(receipts));
          expect(receipts).toHaveLength(shared ? 1 : 2);
          expect(
            new Set(receipts.map(({ pid, processStartTime }) => `${pid}:${processStartTime}`)).size,
          ).toBe(receipts.length);
          for (const receipt of receipts) {
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
        expect(new Set(observations.map(({ parent }) => parent)).size).toBe(2);
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
        }
      } finally {
        const observations = fs.existsSync(fixture.observationsFile) ? fixture.read() : [];
        await Promise.all(
          observations.flatMap(({ pid, parent }) => [
            waitForDead(pid, 5_000),
            waitForDead(parent, 5_000),
          ]),
        );
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
  ] as const)("$name", ({ claim }, { workerArtifacts }) =>
  workerArtifacts.fixtureLifetime.run(async () => {
    const { node } = workerArtifacts.createFixtureCommands();
    const directory = workerArtifacts.fixtureDirectory();
    const fixture = createCiProbe(directory, true, claim === "temporary" ? undefined : claim);
    const env = ciEnv(fixture.probe, 2);
    if (claim === "temporary") {
      // Deliberate TMP claims stay inside this fixture, never the enclosing test's owner.
      const temp = path.join(directory, "tmp");
      fs.mkdirSync(temp);
      Object.assign(env, { TMPDIR: temp, TMP: temp, TEMP: temp });
    }
    const controlled = createControlledWorkerCompiler(directory, env);
    const running = node(command, root, controlled.env);
    try {
      await waitForFixtureFile(fixture.ready, running);
      // Hold first-group until its sibling is borrowing, then join its own receipt.
      fs.writeFileSync(fixture.startFirst, "start");
      await waitForFixtureFile(fixture.firstReady, running);
      const observations = fixture.read();
      const first = observations.find(({ group }) => group === "first-group")!;
      const second = observations.find(({ group }) => group === "second-group")!;
      expect(observations).toHaveLength(2);
      expect(new Set(observations.map(({ generation }) => generation)).size).toBe(1);
      await Promise.all([waitForDead(first.pid, 5_000), waitForDead(first.parent, 5_000)]);
      expect(isProcessAlive(second.pid)).toBe(true);
      expect(fs.existsSync(generationDirectory(first.generation))).toBe(true);
      expect(fs.existsSync(first.includeFile)).toBe(true);
      fs.writeFileSync(fixture.release, "finish");
      const result = await running;
      const receipts = controlled.read();
      expect(receipts).toHaveLength(1);
      console.log("Controlled compiler receipts", JSON.stringify(receipts));
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
      await Promise.all(
        observations.flatMap(({ pid, parent }) => [
          waitForDead(pid, 5_000),
          waitForDead(parent, 5_000),
        ]),
      );
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
