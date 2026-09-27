import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, assert, beforeAll, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../../test/helpers/private-update-handoff-store.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  encodePackageActivationLauncher,
  openPackageActivationJournal,
  resolvePackageActivationJournalPath,
} from "../../infra/package-update-activation-journal.js";
import { preparePackageActivationJournal } from "../../infra/package-update-activation-prepare.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import { createPublicationOwner } from "../../infra/package-update-publication-owner.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { readPersistedInstalledPluginIndexRowSync } from "../../plugins/installed-plugin-index-record-state.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as processRunner from "../../process/exec.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { prepareCandidateAuthorityRuntime } from "./update-command-candidate-authority.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { continuePostCoreUpdateInFreshProcess } from "./update-command-post-core.js";

const lifetime = createFixtureLifetime();
let state: OpenClawTestState;
let packageRoot: string;
let candidateRoot: string;
const durationsMs: Partial<
  Record<
    "fixture" | "publication" | "healthyChild" | "refusalChildren" | "unpublishedChild",
    number
  >
> = {};

beforeAll(async () => {
  const startedAt = performance.now();
  state = await lifetime.acquire(() =>
    createOpenClawTestState({
      label: "post-core-admission",
      env: {
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_UPDATE_RUN_ID: undefined,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_UPDATE_POST_CORE: undefined,
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      },
    }),
  );
  await lifetime.run(async () => {
    packageRoot = state.path("openclaw");
    candidateRoot = state.path("candidate");
    const runtime = await prepareCandidateAuthorityRuntime(candidateRoot);
    // The receiver verifies its loaded package. Source imports from the checkout
    // would bypass the installed-package boundary this regression must exercise.
    expect(fileURLToPath(runtime.worker)).toBe(
      path.join(candidateRoot, "dist", "infra", "update-migrated-finalize.worker.js"),
    );
    // Dependencies are shared beside both generations; publication rejects links
    // escaping the package whose bytes it seals.
    await fs.promises.rename(path.join(candidateRoot, "node_modules"), state.path("node_modules"));
    await fs.promises.unlink(state.path("node_modules", "openclaw"));
    await fs.promises.symlink(packageRoot, state.path("node_modules", "openclaw"), "dir");
    await fs.promises.writeFile(
      path.join(candidateRoot, "dist", "index.js"),
      `import { fileURLToPath } from "node:url";
process.argv[1] = fileURLToPath(new URL("./entry.js", import.meta.url));
await import("./entry.js");
`,
    );
    const workerPath = fileURLToPath(runtime.worker);
    await fs.promises.rename(
      workerPath,
      path.join(path.dirname(workerPath), "update-migrated-finalize.implementation.js"),
    );
    // Keep native children inside the fixture's private temp root. The receiver
    // and all authority/result owners remain real.
    await fs.promises.writeFile(
      workerPath,
      `import { appendFileSync, existsSync } from "node:fs";
import fsp from "node:fs/promises";
import * as json5 from "json5";
import { registerSealedRuntime } from "./sealed-runtime-registry.js";
registerSealedRuntime({ json5, resolveSecureTempRoot: () => ${JSON.stringify(state.path("control"))} });
const resultPath = process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
if (process.argv[2] === "--post-core" && resultPath && existsSync(${JSON.stringify(state.path("fail-response-publication"))})) {
  const rename = fsp.rename;
  fsp.rename = async (from, to) => {
    if (String(to) === resultPath) {
      appendFileSync(${JSON.stringify(state.path("fail-response-publication"))}, String(from) === resultPath + ".pending" ? "pending\\n" : "atomic\\n");
      throw Object.assign(new Error("Fixture response publication failed"), { code: "EIO" });
    }
    return rename(from, to);
  };
}
await import("./update-migrated-finalize.implementation.js");
`,
    );
    const readOnlyWorker = path.join(
      candidateRoot,
      "dist",
      "infra",
      "sqlite-readonly-location.worker.js",
    );
    await fs.promises.rename(
      readOnlyWorker,
      path.join(path.dirname(readOnlyWorker), "sqlite-readonly-location.implementation.js"),
    );
    await fs.promises.writeFile(
      readOnlyWorker,
      `import * as json5 from "json5";
import { registerSealedRuntime } from "./sealed-runtime-registry.js";
registerSealedRuntime({ json5, resolveSecureTempRoot: () => ${JSON.stringify(state.path("control"))} });
await import("./sqlite-readonly-location.implementation.js");
`,
    );
    await writePackageRoot(packageRoot, "2026.8.1");
  });
  durationsMs.fixture = performance.now() - startedAt;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  console.info("Post-core admission durations (ms):", durationsMs);
  await lifetime.cleanup();
});

it.skipIf(process.platform === "win32")(
  "resumes a published package, refuses unowned continuations, and retains unconfirmed results",
  () =>
    lifetime.run(async () => {
      const control = state.path("control");
      fs.mkdirSync(control, { mode: 0o700 });
      const cache = state.path("cache");
      fs.mkdirSync(cache, { mode: 0o700 });
      vi.stubEnv("XDG_CACHE_HOME", cache);
      state.env.XDG_CACHE_HOME = cache;
      const { databasePath } = installPrivateUpdateHandoffStore(control);
      const guardedEnv = writePrivateUpdateHandoffChildGuard(databasePath, control)(state.env);
      vi.stubEnv("NODE_OPTIONS", guardedEnv.NODE_OPTIONS);
      const config: OpenClawConfig = {
        plugins: { enabled: false, slots: { memory: "none" } },
        update: { channel: "stable" },
      };
      await state.writeConfig(config);
      await seedInstalledPluginIndex({}, { config, env: state.env });
      const driver = readUpdateRunDriver();
      expect(driver).toBeDefined();
      const runId = createUpdateRun(
        { trigger: "cli", origin: { driver } },
        { env: state.env },
      ).runId;
      const launchers = state.path("candidate-bin");
      const bin = state.path("bin");
      fs.mkdirSync(launchers);
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "openclaw"), "previous launcher\n");
      fs.writeFileSync(path.join(launchers, "openclaw"), "candidate launcher\n");
      const runChild = processRunner.runUtf8CommandWithTimeout;

      await withUpdateCommandExecutor(runId, async (executor) => {
        const fence = await executor.enter(packageRoot);
        const publicationStartedAt = performance.now();
        const reader = createPackageIntegrityReader();
        const prepared = await preparePackageActivationJournal({
          options: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
          liveRoot: packageRoot,
          stageRoot: candidateRoot,
          launcherRoot: launchers,
          binDir: bin,
          previous: await reader.tree(packageRoot),
          launchers: [
            {
              name: "openclaw",
              previous: encodePackageActivationLauncher(
                await reader.launcher(path.join(bin, "openclaw")),
              ),
            },
          ],
        });
        const publication = createPublicationOwner(
          prepared.anchor,
          prepared.journal,
          fence.assertCurrent,
        );
        await publication.publish(false);
        durationsMs.publication = performance.now() - publicationStartedAt;
        const journal = openPackageActivationJournal(prepared.anchor);
        expect(journal.read().phase).toBe("publication-complete");
        const invoke = () =>
          continuePostCoreUpdateInFreshProcess({
            root: packageRoot,
            channel: "beta",
            requestedChannel: "beta",
            opts: {
              json: true,
              yes: true,
              restart: false,
              run: { runId, env: state.env, executorFence: fence },
            },
            pluginInstallRecords: {},
            updateStartedAtMs: Date.now(),
            timeoutMs: 30_000,
          });

        // Baseline raw-spawns the public CLI without a grant and is refused by
        // the journal before resume. No fixture supplies the child's fence/result.
        const healthyStartedAt = performance.now();
        const healthy = await invoke();
        durationsMs.healthyChild = performance.now() - healthyStartedAt;
        expect(healthy).toMatchObject({ resumed: true, pluginUpdate: { status: "ok" } });
        expect(JSON.parse(fs.readFileSync(state.configPath, "utf8")).update.channel).toBe("beta");
        expect(getUpdateRun(runId, { env: state.env })).toMatchObject({
          status: "running",
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "finalize:installed-candidate", status: "completed" }),
          ]),
        });
        fence.assertCurrent();

        const snapshot = () => ({
          config: fs.readFileSync(state.configPath, "utf8"),
          index: readPersistedInstalledPluginIndexRowSync({ env: state.env }),
          run: getUpdateRun(runId, { env: state.env }),
          journal: fs.readFileSync(resolvePackageActivationJournalPath(prepared.anchor)),
        });
        const unchanged = snapshot();
        const refusalsStartedAt = performance.now();
        const markerResultPath = state.path("marker-result.json");
        const marker = await runChild(
          [
            process.execPath,
            path.join(packageRoot, "dist", "index.js"),
            "update",
            "--json",
            "--yes",
            "--no-restart",
          ],
          {
            cwd: packageRoot,
            env: {
              ...guardedEnv,
              OPENCLAW_UPDATE_IN_PROGRESS: "1",
              OPENCLAW_UPDATE_POST_CORE: "1",
              OPENCLAW_UPDATE_POST_CORE_CHANNEL: "beta",
              OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: markerResultPath,
              OPENCLAW_UPDATE_RUN_ID: runId,
            },
            timeoutMs: 30_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        );
        expect(marker.code, marker.stderr).toBe(1);
        expect(marker.stdout + marker.stderr).toContain("update-recovery-pending");
        expect(fs.existsSync(markerResultPath)).toBe(false);
        expect(snapshot()).toEqual(unchanged);

        let mismatchedPid: number | undefined;
        let refusal: Awaited<ReturnType<typeof runChild>> | undefined;
        const transport = vi
          .spyOn(processRunner, "runUtf8CommandWithTimeout")
          .mockImplementation(async (argv, options) => {
            if (!argv.includes("--post-core")) {
              return runChild(argv, options);
            }
            if (typeof options === "number" || typeof options.input !== "string") {
              throw new Error("Post-core producer did not supply its private input");
            }
            const input = JSON.parse(options.input) as { runId: string };
            expect(input.runId).toBe(runId);
            refusal = await runChild(argv, {
              ...options,
              input: JSON.stringify({ ...input, runId: "another-update-run" }),
              beforeInput: (pid, spawnedArgv) => {
                options.beforeInput?.(pid, spawnedArgv);
                mismatchedPid = pid;
              },
            });
            return refusal;
          });
        try {
          await expect(invoke()).resolves.toMatchObject({ resumed: false, exitCode: 1 });
        } finally {
          transport.mockRestore();
        }
        expect(mismatchedPid).toBeGreaterThan(0);
        expect(refusal?.code).toBe(1);
        expect(refusal?.stderr).toMatch(/post-core|update run/i);
        expect(snapshot()).toEqual(unchanged);
        fence.assertCurrent();
        durationsMs.refusalChildren = performance.now() - refusalsStartedAt;

        const { run: beforeUnpublishedRun, ...beforeUnpublishedState } = snapshot();
        assert(beforeUnpublishedRun, "The admitted update run must remain available");
        const faultPath = state.path("fail-response-publication");
        await fs.promises.writeFile(faultPath, "EIO\n");
        let retainedResultPath: string | undefined;
        let stateAfterChild: ReturnType<typeof snapshot> | undefined;
        const unpublishedTransport = vi
          .spyOn(processRunner, "runUtf8CommandWithTimeout")
          .mockImplementation(async (argv, options) => {
            const postCore = argv.includes("--post-core") && typeof options !== "number";
            if (postCore) {
              retainedResultPath = options.env?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
            }
            const result = await runChild(argv, options);
            if (postCore) {
              stateAfterChild = snapshot();
            }
            return result;
          });
        const unpublishedStartedAt = performance.now();
        try {
          const outcome = await invoke().then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          expect(fs.readFileSync(faultPath, "utf8")).toBe("EIO\npending\natomic\n");
          expect(outcome).toMatchObject({ error: expect.any(CommandProcessCleanupError) });
          assert(retainedResultPath, "Post-core producer must provide its private result path");
          expect(fs.existsSync(retainedResultPath)).toBe(false);
          expect(
            JSON.parse(fs.readFileSync(`${retainedResultPath}.pending`, "utf8")),
          ).toMatchObject({
            status: "ok",
          });
          assert(stateAfterChild, "The real post-core child must finish before parent settlement");
          expect(stateAfterChild.config).toEqual(beforeUnpublishedState.config);
          expect(stateAfterChild.journal).toEqual(beforeUnpublishedState.journal);
          // Resume can refresh index metadata; the parent must preserve the child's exact state.
          expect(snapshot()).toEqual(stateAfterChild);
          expect(stateAfterChild.run).toMatchObject({
            runId,
            status: "running",
            steps: expect.arrayContaining([
              expect.objectContaining({
                step: "finalize:installed-candidate",
                status: "completed",
              }),
            ]),
          });
          expect(stateAfterChild.run?.updatedAtMs).toBeGreaterThan(
            beforeUnpublishedRun.updatedAtMs,
          );
          fence.assertCurrent();
        } finally {
          durationsMs.unpublishedChild = performance.now() - unpublishedStartedAt;
          unpublishedTransport.mockRestore();
          await fs.promises.rm(faultPath, { force: true });
          if (retainedResultPath) {
            await fs.promises.rm(path.dirname(retainedResultPath), {
              recursive: true,
              force: true,
            });
          }
        }
      });
      expect(createManagedHandoffLeaseStore().read(packageRoot)).toEqual({ kind: "absent" });
    }),
);
