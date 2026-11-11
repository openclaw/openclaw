import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPackageSwapFixture } from "../infra/package-update-swap.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveRetainedRuntimeTestRoot } from "../infra/update-retained-runtime-alias.test-support.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  cliCleanupRetirementEntrypoints,
  cliRetainedCompositionEntrypoint,
} from "./cli-entrypoint.test-support.js";
import {
  CLI_PROCESS_DEADLOCK_GUARD_MS,
  formatCliProcessFailure,
  getCliProcessTestTimeout,
  runCliProcessChild,
} from "./cli-process-child.test-helpers.js";
import { copyCliRetainedCompositionGraph } from "./runtime-cleanup-retained.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const entries = Object.fromEntries(
  Object.entries(cliCleanupRetirementEntrypoints).map(([name, entry]) => [
    name,
    resolveRuntimeWorkerUrl(entry).href,
  ]),
);

it.each(["success", "failure"])(
  "drains executable resources after source replacement without changing %s",
  async (outcome) => {
    const directory = directories.make("openclaw-cli-cleanup-retirement-");
    const nodeExecutable = resolveTestNodeExecPath();
    const result = await runCliProcessChild({
      nodeExecutable,
      nodeArgs: [
        ...resolveRuntimeWorkerArgv(new URL(entries.scope!), nodeExecutable).slice(0, -1),
        "--input-type=module",
        "--eval",
        String.raw`
          import assert from "node:assert/strict";
          import { copyFileSync, unlinkSync } from "node:fs";
          import { once } from "node:events";
          import { registerHooks } from "node:module";
          import { join } from "node:path";
          import { pathToFileURL } from "node:url";

          const entries = ${JSON.stringify(entries)};
          const copies = new Map(Object.entries(entries).map(([name, source]) => [
            source, pathToFileURL(join(${JSON.stringify(directory)}, name + ".mjs")).href,
          ]));
          const originals = new Map([...copies].map(([source, copy]) => [copy, source]));
          for (const [source, copy] of copies) copyFileSync(new URL(source), new URL(copy));
          // Copied owners move; other imports retain the prepared graph. Node still
          // checks each copy exists, including already imported cleanup modules.
          let executableAdmission = false;
          let skillsResolutions = 0;
          const hooks = registerHooks({
            resolve(specifier, context, nextResolve) {
              const parentURL = originals.get(context.parentURL) ?? context.parentURL;
              const requested = specifier.startsWith(".")
                ? new URL(specifier, parentURL).href : specifier;
              if (requested === entries.skills) {
                assert(executableAdmission, "skills watcher loaded during CLI bootstrap");
                skillsResolutions++;
              }
              return nextResolve(copies.get(requested) ?? specifier, { ...context, parentURL });
            },
          });
          const { withCliProcessScope, withCliCommandCleanup } = await import(entries.scope);
          // The ordinary entry loads cleanup elsewhere first; this does not prime
          // the cleanup scope's distinct resolution after its files disappear.
          const { closeCliResources, waitForPendingCliDisposers } = await import(entries.cleanup);
          const { registerOpenClawStateDatabaseAsyncResource } = await import(entries.database);
          const { createRetainedNativeWorker, closeDefaultRetainedNativeWorkerSource } =
            await import(entries.workers);
          const supervisors = [];
          const captureWorker = worker => supervisors.push(worker);
          process.on("worker", captureWorker);
          const worker = createRetainedNativeWorker(
            'const {parentPort} = require("node:worker_threads"); parentPort.on("message", () => {}); parentPort.postMessage("ready");',
            { eval: true, env: {} },
          );
          await once(worker, "message");
          assert(supervisors.length > 0);
          assert(supervisors.every(worker => worker.threadId !== -1));
          let closed = false;
          const unregister = registerOpenClawStateDatabaseAsyncResource({
            async close() { await worker.terminate(); closed = true; unregister(); },
          });
          const commandError = new Error("synthetic command failure");
          let watchersClosed = false;
          executableAdmission = true;
          try {
            const command = withCliProcessScope(() => withCliCommandCleanup(false, async cleanup => {
              assert(skillsResolutions > 0, "watcher callback was not retained before dispatch");
              assert.equal(typeof cleanup.closeSkillsWatchers, "function");
              const closeWatchers = cleanup.closeSkillsWatchers;
              let releaseWatchers;
              let watcherCloseStarted;
              const watcherGate = new Promise(resolve => { releaseWatchers = resolve; });
              const watcherStarted = new Promise(resolve => { watcherCloseStarted = resolve; });
              cleanup.closeSkillsWatchers = async () => {
                watcherCloseStarted();
                await watcherGate;
                await closeWatchers();
                watchersClosed = true;
              };
              try {
                for (const copy of copies.values()) unlinkSync(new URL(copy));
                if (${JSON.stringify(outcome)} === "failure") throw commandError;
                return "command-result";
              } finally {
                let settled = false;
                const closing = closeCliResources(cleanup).then(() => { settled = true; });
                await watcherStarted;
                assert.equal(settled, false, "watcher retirement was not joined");
                releaseWatchers();
                await closing;
                await cleanup.pluginResources.release();
              }
            }));
            if (${JSON.stringify(outcome)} === "failure") {
              await assert.rejects(command, error => error === commandError);
            } else {
              assert.equal(await command, "command-result");
            }
            await waitForPendingCliDisposers();
            assert.equal(closed, true);
            assert.equal(watchersClosed, true);
            assert(supervisors.every(worker => worker.threadId === -1));
            console.log("cleanup joined after source retirement");
          } finally {
            await worker.terminate();
            unregister();
            await closeDefaultRetainedNativeWorkerSource();
            process.off("worker", captureWorker);
            hooks.deregister();
          }
        `,
      ],
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        OPENCLAW_STATE_DIR: directory,
        TMPDIR: process.env.TMPDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
      },
    });
    const failure = formatCliProcessFailure({ reason: "CLI source retirement failed", ...result });
    expect(result.signal, failure).toBeNull();
    expect(result.code, failure).toBe(0);
    expect(result.stdout, failure).toContain("cleanup joined after source retirement");
  },
);

// Distinct from the captured-callback test above: this runs the real outer CLI,
// exit finalization and nonempty resource owners after a real package swap.
const compositionEntrypoint = resolveRuntimeWorkerUrl(cliRetainedCompositionEntrypoint);
// Temporary diagnostic observation window, not a production deadline or passing latency claim.
const compositionChildTimeoutMs =
  process.env.OPENCLAW_RETAINED_ALIAS_DIAGNOSTICS === "1" ? 180_000 : CLI_PROCESS_DEADLOCK_GUARD_MS;
for (const runtime of ["node", "node-short-path"] as const) {
  describe.skipIf(runtime === "node-short-path" && process.platform !== "win32")(
    runtime + " retained CLI fixture",
    () => {
      const composition = createFixtureLifetime();
      let prepared: {
        directory: string;
        fixture: Awaited<ReturnType<typeof createPackageSwapFixture>>;
        importRoot: string;
      };
      let started: number;
      const stage = (phase: string) =>
        console.log(
          JSON.stringify({
            phase: "cli-composition-setup",
            runtime,
            stage: phase,
            elapsedMs: Math.round(performance.now() - started),
          }),
        );
      // Declarations already prepare the compiled generation at collection. Move
      // its physical copy/inventory out of the child guard's test budget too.
      // The lifetime joins preparation even if this hook fails or times out.
      beforeAll(async () => {
        prepared = await composition.run(async () => {
          started = performance.now();
          // The Windows system temp volume supports 8.3 names; the checkout volume
          // may not. Keep unchanged dependencies in ordinary ancestry, outside the
          // package mutation root, rather than repairing missing runtime imports.
          const directory = composition.createTempDir("cli-retained-composition-");
          await fs.symlink(
            path.resolve("node_modules"),
            path.join(directory, "node_modules"),
            process.platform === "win32" ? "junction" : "dir",
          );
          stage("fixture-root-created");
          const fixture = await createPackageSwapFixture(directory);
          const importRoot = await resolveRetainedRuntimeTestRoot(fixture.packageRoot, runtime);
          stage("graph-copy-started");
          await copyCliRetainedCompositionGraph({
            preparedEntrypoint: compositionEntrypoint,
            root: fixture.packageRoot,
            importRoot,
          });
          stage("graph-copy-completed");
          await fs.writeFile(
            path.join(fixture.packageRoot, "package.json"),
            JSON.stringify({ name: "openclaw", version: "1.0.0", type: "module" }),
          );
          stage("inventory-started");
          await writePackageDistInventory(fixture.packageRoot);
          stage("inventory-completed");
          return { directory, fixture, importRoot };
        });
      });
      afterAll(async () => await composition.cleanup());

      it(
        "drains real CLI resources after " + runtime + " retained-update composition",
        async () => {
          const { directory, fixture, importRoot } = prepared;
          const stateDirectory = path.join(directory, "state");
          const nodeExecutable = resolveTestNodeExecPath();
          stage("child-launch");
          const result = await composition.track(
            runCliProcessChild({
              nodeExecutable,
              nodeArgs: [
                ...resolveRuntimeWorkerArgv(compositionEntrypoint, nodeExecutable),
                "--retained-cli-composition",
                JSON.stringify({ root: fixture.packageRoot, importRoot, swap: fixture.params }),
              ],
              env: {
                PATH: process.env.PATH,
                SystemRoot: process.env.SystemRoot,
                HOME: stateDirectory,
                USERPROFILE: stateDirectory,
                OPENCLAW_STATE_DIR: stateDirectory,
                OPENCLAW_CONFIG_PATH: path.join(stateDirectory, "openclaw.json"),
                OPENCLAW_TEST_FAST: "1",
                OPENCLAW_RETAINED_ALIAS_DIAGNOSTICS: process.env.OPENCLAW_RETAINED_ALIAS_DIAGNOSTICS,
                NODE_DISABLE_COMPILE_CACHE: "1",
                TMPDIR: directory,
                TMP: directory,
                TEMP: directory,
              },
              timeoutMs: compositionChildTimeoutMs,
            }),
          );
          stage("child-settled");
          const failure = formatCliProcessFailure({
            reason: "CLI retained-update composition failed",
            ...result,
          });
          expect(result.signal, failure).toBeNull();
          expect(result.code, failure).toBe(0);
          expect(result.stderr, failure).not.toMatch(
            /CLI cleanup (?:failed|timed out|deferred)|Plugin CLI resource disposal failed|watchdog|descendant completion is unverified/iu,
          );
          // Machine-output CLI routes console logs to stderr. Accept either real
          // stream without modifying runCli or losing the independent warning gate.
          const lines = [result.stdout, result.stderr]
            .flatMap((output) => output.split(/\r?\n/u))
            .filter((value) => value.startsWith('{"phase":"cli-retained-composition"'));
          expect(lines, failure).toHaveLength(1);
          const line = lines[0]!;
          const receipt = JSON.parse(line) as {
            requested: string;
            observed: string;
            physical: string;
            phases: string[];
            disposeCalls: number;
            supervisors: number;
            joined: boolean;
            databasePath: string;
            retainedRegistryUrl: string;
            resolvedRegistryUrl: string;
          };
          expect(receipt.observed).toBe(receipt.requested);
          if (runtime === "node-short-path") {
            expect(receipt.observed).not.toBe(receipt.physical);
          }
          expect(receipt.phases).toEqual([
            "source-replaced",
            "retention-settled",
            "dispose-after-retention",
            "write-committed",
            "shared-state-closed",
          ]);
          expect(receipt.resolvedRegistryUrl).toBe(receipt.retainedRegistryUrl);
          expect(receipt.resolvedRegistryUrl).not.toBe(receipt.requested);
          expect(receipt.disposeCalls).toBe(1);
          expect(receipt.supervisors).toBeGreaterThan(0);
          expect(receipt.joined).toBe(true);
          // The child has exited and its actual async close has settled. Read the
          // durable file independently; a callback flag is not persistence proof.
          const database = new DatabaseSync(receipt.databasePath, { readOnly: true });
          try {
            expect(database.prepare("SELECT flow_id FROM capture_events").all()).toEqual([
              { flow_id: "accepted-after-retention" },
            ]);
          } finally {
            database.close();
          }
          console.log(line);
        },
        getCliProcessTestTimeout(compositionChildTimeoutMs),
      );
    },
  );
}
