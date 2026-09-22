import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "../../node-host/node-worker-process-identity.js";
import * as commandRunner from "../../process/exec.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { legacyFinalizeEntrypoint } from "./update-command-legacy-finalize-entrypoint.test-support.js";

// Vitest cancellation ends its wrapper before the body unwinds. Keep the
// authority database and scratch inputs until that original body has joined.
const fixture = createFixtureLifetime();
const testNodeExecPath = resolveTestNodeExecPath();
afterEach(() => fixture.cleanup());

async function closeLegacyFixture(
  command: ReturnType<typeof commandRunner.runUtf8CommandWithTimeout> | undefined,
  release: () => void,
) {
  await fixture.verifyCleanup(async () => {
    const result = await command;
    assertLegacyCommandJoined(result);
    release();
    stateDatabase.closeOpenClawStateDatabase();
  });
}

function assertLegacyCommandJoined(
  result: Awaited<ReturnType<typeof commandRunner.runUtf8CommandWithTimeout>> | undefined,
) {
  if (result?.cleanup === "uncertain") {
    throw new Error("Legacy finalizer process cleanup is unverified", {
      cause: {
        pid: result.pid,
        code: result.code,
        signal: result.signal,
        termination: result.termination,
        cleanup: result.cleanup,
        killed: result.killed,
        stdoutTail: result.stdout.slice(-8192),
        stderrTail: result.stderr.slice(-8192),
      },
    });
  }
}

const scenarios = [
  "state-migrated-no-rollback",
  "rollback-state-unverified",
  "revoked",
  "retargeted",
  "grantless",
  "grantless-incumbent",
  "grantless-scratch",
  "grantless-scratch-incumbent",
  "grantless-scratch-owned",
  "grantless-scratch-owned-incumbent",
  "grantless-scratch-owned-parent-git",
  "grantless-scratch-owned-parent-completed",
  "grantless-scratch-owned-parent-npm",
  "grantless-scratch-owned-parent-pnpm-root-move",
  "grantless-scratch-owned-parent-git-root-switch",
  "grantless-scratch-owned-parent-wrong-handoff",
  "grantless-scratch-owned-parent-wrong-run",
  "grantless-scratch-owned-parent-wrong-root",
  "grantless-scratch-owned-parent-wrong-version",
  "grantless-scratch-owned-parent-wrong-scratch",
  "grantless-scratch-owned-parent-wrong-parent",
  "grantless-scratch-owned-parent-registered-child",
  "grantless-scratch-owned-parent-revoked",
  "grantless-scratch-owned-parent-retargeted",
] as const;

it.for(scenarios)(
  "shipped legacy grant completes migrated finalization and native restart: %s",
  { timeout: 90_000 },
  (scenario, { signal }) => runLegacyFinalizationScenario(scenario, signal),
);

it(
  "reports migrated finalizer capabilities through its real validation entrypoint",
  { timeout: 90_000 },
  ({ signal }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const scratch = fs.realpathSync(fixture.createTempDir("legacy-native-check-"));
      const configPath = path.join(scratch, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
      let command: ReturnType<typeof commandRunner.runUtf8CommandWithTimeout> | undefined;
      try {
        command = commandRunner.runUtf8CommandWithTimeout(
          [
            testNodeExecPath,
            ...resolveRuntimeWorkerArgv(
              resolveRuntimeWorkerUrl(legacyFinalizeEntrypoint),
              testNodeExecPath,
            ),
            JSON.stringify(runtimeProcessEntrypoints.sqliteReadOnly),
            "--check",
          ],
          {
            env: {
              ...process.env,
              HOME: scratch,
              USERPROFILE: scratch,
              OPENCLAW_HOME: scratch,
              OPENCLAW_STATE_DIR: scratch,
              OPENCLAW_CONFIG_PATH: configPath,
              TMPDIR: scratch,
              TMP: scratch,
              TEMP: scratch,
            },
            baseEnv: {},
            cwd: process.cwd(),
            timeoutMs: 60_000,
            signal,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        );
        const result = await command;
        assertLegacyCommandJoined(result);
        signal.throwIfAborted();
        const details = result.stderr + "\n" + result.stdout;
        expect(result.termination, details).toBe("exit");
        expect(result.code, details).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          executorDelegation: "pid-start-v1",
          retainedOwnerBinding: true,
          doctorConfigWrites: "pid-start-v1",
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        });
      } finally {
        await closeLegacyFixture(command, () => {});
      }
    }),
);

function runLegacyFinalizationScenario(scenario: (typeof scenarios)[number], signal: AbortSignal) {
  return fixture.run(async () => {
    signal.throwIfAborted();
    const scratch = fs.realpathSync(fixture.createTempDir("legacy-native-finalize-"));
    const root = fs.realpathSync(process.cwd());
    const switchedRoot = scenario.endsWith("-git-root-switch");
    const movedRoot = switchedRoot || scenario.endsWith("-pnpm-root-move");
    const parentRoot = movedRoot ? path.join(scratch, "previous-installation") : root;
    const candidateRoot = movedRoot ? path.join(scratch, "candidate-installation") : root;
    if (movedRoot) {
      fs.mkdirSync(parentRoot);
      fs.mkdirSync(candidateRoot);
      fs.writeFileSync(
        path.join(candidateRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.4", type: "module" }),
      );
    }
    const configPath = path.join(scratch, "openclaw.json");
    const scratchEnvironment = scenario.includes("-scratch");
    const ownedEnvironment = scenario.includes("-owned");
    const incumbent = scenario.endsWith("-incumbent");
    const legacyParent = scenario.includes("-parent-");
    const completedByGateway = scenario.endsWith("-completed");
    const refusedParent = scenario.includes("-wrong-") || scenario.endsWith("-registered-child");
    const normalTemp = path.join(scratch, "normal-temp");
    const workerTemp = path.join(scratch, "openclaw-update-migrated-fixture");
    const unsafePreferred = path.join(scratch, "unavailable-preferred");
    if (scratchEnvironment) {
      fs.mkdirSync(normalTemp);
      fs.mkdirSync(workerTemp);
      // Force the real POSIX fallback without touching /tmp/openclaw. Windows
      // already skips preferredDir. Keep os.tmpdir and secure filesystem checks real.
      fs.writeFileSync(unsafePreferred, "not a directory");
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: scratch,
      USERPROFILE: scratch,
      OPENCLAW_HOME: scratch,
      OPENCLAW_STATE_DIR: scratch,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_TEST_RUNTIME_LOG: "1",
      ...(completedByGateway ? { OPENCLAW_TEST_COMPLETED_TERMINAL: "1" } : {}),
      ...(scratchEnvironment
        ? {
            TMPDIR: ownedEnvironment ? workerTemp : normalTemp,
            TMP: ownedEnvironment ? workerTemp : normalTemp,
            TEMP: ownedEnvironment ? workerTemp : normalTemp,
            OPENCLAW_TEST_LEGACY_TEMP_FALLBACK: "1",
          }
        : {}),
    };
    for (const name of [
      "OPENCLAW_SERVICE_KIND",
      "OPENCLAW_SERVICE_MARKER",
      "OPENCLAW_SERVICE_REPAIR_POLICY",
    ]) {
      delete env[name];
    }
    let command: ReturnType<typeof commandRunner.runUtf8CommandWithTimeout> | undefined;
    let releaseParent: (() => void) | undefined;
    let releaseChild: (() => void) | undefined;
    try {
      fs.writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      if (completedByGateway) {
        const candidateState = new DatabaseSync(path.join(scratch, "state", "openclaw.sqlite"), {
          readOnly: true,
        });
        try {
          // The shipped v2026.9.3 producer supports state schema 16. The real
          // candidate below must own all access to this genuinely newer state.
          const version = candidateState.prepare("PRAGMA user_version").get()?.user_version;
          expect(version).toBeGreaterThan(16);
        } finally {
          candidateState.close();
        }
      }
      if (legacyParent) {
        env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
        env.OPENCLAW_UPDATE_RUN_ID = runId;
      }
      const originalEnvironment = ownedEnvironment
        ? { ...env, TMPDIR: normalTemp, TMP: normalTemp, TEMP: normalTemp }
        : env;
      const leaseDirectory = scratchEnvironment
        ? resolvePreferredOpenClawTmpDir({
            preferredDir: unsafePreferred,
            tmpdir: () => normalTemp,
          })
        : scratch;
      const databasePath = path.join(leaseDirectory, "managed-update-handoffs.sqlite");
      const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: env });
      const acquired = store.acquire(parentRoot, randomUUID(), { kind: "update" });
      if (acquired.kind !== "acquired") {
        throw new Error("Missing original owner");
      }
      let parentLease = acquired.lease;
      releaseParent = () => {
        store.release(parentLease);
      };
      // Exact v2026.9.4 producer format (3a9d69db): real UUID child registration,
      // parent row and private input, with no later lineage or database-pin fields.
      const child = store.acquire(`${parentRoot}/.openclaw-update-child-${randomUUID()}`, runId, {
        kind: "update",
      });
      if (child.kind !== "acquired") {
        throw new Error("Missing legacy child");
      }
      let bound = child.lease;
      releaseChild = () => {
        store.release(bound);
      };
      const executor = {
        runId,
        root,
        databasePath,
        parent: acquired.lease,
        childKey: child.lease.key,
      };
      const entry = path.join(scratch, "native-entry.mjs");
      const loader = path.resolve("scripts/tsx.mjs");
      // Both receiver imports share the same graph and service-authority scope.
      const owner = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExecutor);
      const exec = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExec).href;
      const receiverUrl = movedRoot
        ? pathToFileURL(path.join(candidateRoot, `native-receiver${path.extname(owner.pathname)}`))
        : owner;
      if (movedRoot) {
        // Keep the receiver's real package-root check, sharing its dependencies
        // with the effect owner so both use the same authority scope.
        fs.copyFileSync(fileURLToPath(owner), fileURLToPath(receiverUrl));
      }
      fs.writeFileSync(
        entry,
        `
      ${owner.pathname.endsWith(".ts") ? `await import(${JSON.stringify(loader)});` : ""}
      const fs=await import("node:fs");
      const {DatabaseSync}=await import("node:sqlite");
      ${
        movedRoot
          ? `const {registerHooks}=await import("node:module");
      registerHooks({resolve(specifier,context,nextResolve){
        return nextResolve(specifier,context.parentURL===${JSON.stringify(receiverUrl.href)}
          ? {...context,parentURL:${JSON.stringify(owner.href)}} : context);
      }});`
          : ""
      }
      const {runGatewayServiceUpdateCommand}=await import(${JSON.stringify(receiverUrl.href)});
      const {execFileUtf8}=await import(${JSON.stringify(exec)});
      const mode=process.argv[process.argv.indexOf("--update-executor")+1];
      await runGatewayServiceUpdateCommand(mode,"restart",async()=>{
        fs.writeFileSync(${JSON.stringify(scratch + "/receiver-pid")},JSON.stringify({pid:process.pid,parent:process.ppid}));
        if(${JSON.stringify(scenario)}.endsWith("revoked")) {
          const db=new DatabaseSync(${JSON.stringify(databasePath)});
          db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run("revoked",${JSON.stringify(root)});db.close();
        }
        if(${JSON.stringify(scenario)}.endsWith("retargeted")) {
          fs.copyFileSync(${JSON.stringify(databasePath)},${JSON.stringify(databasePath + ".copy")});
          fs.renameSync(${JSON.stringify(databasePath + ".copy")},${JSON.stringify(databasePath)});
        }
        const r=await execFileUtf8(process.execPath,["-e",${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(scratch + "/native-effect")},"restarted")`)}]);
        if(r.code!==0)throw new Error(r.stderr);
        process.stdout.write(JSON.stringify({action:"restart",ok:true,result:"restarted"}));
      });
    `,
      );
      const snapshot = {
        path: configPath,
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: {},
        resolved: {},
        valid: true,
        runtimeConfig: {},
        config: {},
        issues: [],
        warnings: [],
        legacyIssues: [],
      };
      const grantless = scenario.startsWith("grantless");
      if (legacyParent) {
        // v2026.9.3 has no child grant: its managed updater keeps the root lease
        // while awaiting the candidate's private result.json (migrated.ts:176).
        if (!scenario.endsWith("-registered-child")) {
          expect(store.release(bound)).toBe(true);
        }
      } else if (grantless && !incumbent) {
        expect(store.release(bound)).toBe(true);
        expect(store.release(acquired.lease)).toBe(true);
      }
      if (switchedRoot) {
        // The shipped package-to-Git publisher retargets the old package path.
        fs.renameSync(parentRoot, path.join(scratch, "retained-installation"));
        fs.symlinkSync(
          candidateRoot,
          parentRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const input = {
        ...(grantless ? {} : { executor }),
        bufferedSteps: [],
        resultPath: path.join(legacyParent ? workerTemp : scratch, "result.json"),
        params: {
          root: parentRoot,
          ...(ownedEnvironment ? { ownedManagedUpdateEnv: originalEnvironment } : {}),
          mutationStarted: true,
          installKindChanged: switchedRoot,
          configSnapshot: snapshot,
          requestedChannel: null,
          storedChannel: "stable",
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: true,
          opts: { json: true, yes: true, run: { runId, env } },
          result: {
            status: "ok",
            ...(completedByGateway
              ? { after: { version: "2026.9.5", buildId: "verified-migrated-candidate" } }
              : {}),
            mode: switchedRoot || scenario.endsWith("-git") ? "git" : movedRoot ? "pnpm" : "npm",
            ...(legacyParent
              ? {
                  before: {
                    version: scenario.endsWith("-wrong-version") ? "2026.9.4" : "2026.9.3",
                  },
                }
              : {}),
            root: candidateRoot,
            steps: [],
            durationMs: 0,
          },
          controlPlaneUpdateSentinelMeta: legacyParent
            ? {
                runId: scenario.endsWith("-wrong-run") ? randomUUID() : runId,
                handoffId: scenario.endsWith("-wrong-handoff")
                  ? randomUUID()
                  : acquired.lease.owner,
                root: scenario.endsWith("-wrong-root")
                  ? path.join(root, "other-installation")
                  : parentRoot,
              }
            : null,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          packageUpdateNodeRunner: testNodeExecPath,
          updateStepTimeoutMs: 20000,
          rollbackBlockedReason:
            scenario === "rollback-state-unverified" ? scenario : "state-migrated-no-rollback",
        },
      };
      command = commandRunner.runUtf8CommandWithTimeout(
        [
          testNodeExecPath,
          ...resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl(legacyFinalizeEntrypoint),
            testNodeExecPath,
          ),
          JSON.stringify(runtimeProcessEntrypoints.sqliteReadOnly),
        ],
        {
          input: JSON.stringify(input),
          env: scratchEnvironment
            ? {
                ...originalEnvironment,
                TMPDIR: workerTemp,
                TMP: scenario.endsWith("-wrong-scratch") ? normalTemp : workerTemp,
                TEMP: workerTemp,
              }
            : env,
          baseEnv: {},
          cwd: root,
          timeoutMs: 60000,
          signal,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          beforeInput(pid) {
            if (scenario.endsWith("-wrong-parent")) {
              const reassigned = store.bind(parentLease, pid);
              if (!reassigned) {
                throw new Error("Parent reassignment failed");
              }
              parentLease = reassigned;
            }
            if (grantless) {
              return;
            }
            const registered = store.bind(child.lease, pid);
            if (!registered) {
              throw new Error("Legacy binding failed");
            }
            bound = registered;
          },
        },
      );
      const result = await command;
      assertLegacyCommandJoined(result);
      signal.throwIfAborted();
      const details = result.stderr + "\n" + result.stdout;
      expect(result.termination, details).toBe("exit");
      if (incumbent || refusedParent) {
        expect(result.code, details).not.toBe(0);
        expect(fs.existsSync(path.join(scratch, "receiver-pid"))).toBe(false);
        expect(store.current(parentLease)).toBe(true);
        expect(fs.existsSync(path.join(scratch, "native-effect"))).toBe(false);
        expect(fs.existsSync(input.resultPath)).toBe(false);
        expect(getUpdateRun(runId, { env })?.status).toBe("running");
      } else if (scenario.endsWith("revoked") || scenario.endsWith("retargeted")) {
        expect(fs.existsSync(path.join(scratch, "receiver-pid")), details).toBe(true);
        expect(fs.existsSync(path.join(scratch, "native-effect")), details).toBe(false);
        expect(result.code, details).not.toBe(0);
      } else {
        expect(
          result.code,
          `${details}\nresult.json exists: ${fs.existsSync(input.resultPath)}`,
        ).toBe(0);
        expect(JSON.parse(fs.readFileSync(input.resultPath, "utf8")), details).toMatchObject({
          exitCode: 0,
          terminalRunId: runId,
          result: { status: "ok", root: candidateRoot, runId },
        });
        expect(fs.readFileSync(path.join(scratch, "native-effect"), "utf8")).toBe("restarted");
        const receiver = JSON.parse(fs.readFileSync(path.join(scratch, "receiver-pid"), "utf8"));
        expect(receiver.parent).toBe(
          Number(fs.readFileSync(path.join(scratch, "finalizer-pid"), "utf8")),
        );
        expect(receiver.pid).not.toBe(receiver.parent);
        expect(getUpdateRun(runId, { env })).toMatchObject({ status: "succeeded" });
        if (legacyParent) {
          expect(store.current(acquired.lease)).toBe(true);
          expect(store.hasUnsettledChildren(acquired.lease)).toBe(false);
          expect(store.release(acquired.lease)).toBe(true);
        } else if (!grantless) {
          expect(store.release(bound)).toBe(true);
          expect(store.release(acquired.lease)).toBe(true);
        }
        expect(store.read(parentRoot).kind).toBe("absent");
        expect(store.read(candidateRoot).kind).toBe("absent");
      }
      if (scratchEnvironment) {
        // Neither healthy completion nor refusal may create a worker-private
        // competing lease database. This is the shipped producer's temp override.
        const workerLeasePath = path.join(
          workerTemp,
          typeof process.getuid === "function" ? `openclaw-${process.getuid()}` : "openclaw",
          "managed-update-handoffs.sqlite",
        );
        expect(fs.existsSync(workerLeasePath), details).toBe(false);
      }
    } finally {
      await closeLegacyFixture(command, () => {
        releaseChild?.();
        releaseParent?.();
      });
    }
  });
}

it.for(["joined", "uncertain"] as const)(
  "joins the legacy fixture before releasing its inputs (cleanup=%s)",
  async (cleanup, { signal: contextSignal }) => {
    contextSignal.throwIfAborted();
    // A failed drain deliberately retains its claim. Isolate that expected
    // refusal from the resource owner running the surrounding suite.
    const namespace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "legacy-cleanup-owner-")),
    );
    const owner = createVitestResourceOwner(namespace);
    for (const key of ["TMPDIR", "TMP", "TEMP"]) {
      vi.stubEnv(key, namespace);
    }
    const cancellation = new AbortController();
    const rescue = new AbortController();
    const signal = AbortSignal.any([contextSignal, cancellation.signal]);
    const reason = new Error("legacy fixture canceled");
    const ready = createDeferred();
    const joined = createDeferred();
    const returnResult = createDeferred();
    const run = commandRunner.runUtf8CommandWithTimeout;
    const closeDatabase = stateDatabase.closeOpenClawStateDatabase;
    const remove = fs.promises.rm;
    const events: string[] = [];
    let scratch = "";
    let childKey = "";
    let fixtureEnv: NodeJS.ProcessEnv | undefined;
    let identity: ReturnType<typeof requireNodeWorkerProcessIdentity> | undefined;
    let command: ReturnType<typeof run> | undefined;
    let output = "";
    const root = fs.realpathSync(process.cwd());
    const leaseStore = () => {
      if (!fixtureEnv) {
        throw new Error("Legacy fixture command environment was not captured");
      }
      return createManagedHandoffLeaseStore({
        databasePath: path.join(scratch, "managed-update-handoffs.sqlite"),
        serviceManagerEnv: fixtureEnv,
      });
    };
    const unblock = () => {
      returnResult.resolve();
      rescue.abort(contextSignal.reason);
    };
    contextSignal.addEventListener("abort", unblock, { once: true });
    vi.spyOn(commandRunner, "runUtf8CommandWithTimeout").mockImplementation((_argv, options) => {
      if (typeof options === "number") {
        throw new Error("Legacy fixture lost its command options");
      }
      expect(options.signal).toBe(signal);
      fixtureEnv = options.env;
      if (!fixtureEnv) {
        throw new Error("Legacy fixture lost its command environment");
      }
      scratch = fixtureEnv.OPENCLAW_STATE_DIR!;
      childKey = (JSON.parse(String(options.input)) as { executor: { childKey: string } }).executor
        .childKey;
      // Substitute only this fixture payload, not the real runner, admission,
      // cancellation or process-tree owner used by the legacy scenario.
      command = run(
        [
          process.execPath,
          "-e",
          'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
        ],
        {
          ...options,
          signal: AbortSignal.any([options.signal!, rescue.signal]),
          beforeInput(pid) {
            options.beforeInput!(pid);
            identity = requireNodeWorkerProcessIdentity(pid);
          },
          onOutputChunk(chunk, stream) {
            if (stream === "stdout") {
              output = (output + chunk.toString("utf8")).slice(-16);
              if (output.includes("ready\n")) {
                ready.resolve();
              }
            }
          },
        },
      );
      return command.then(async (result): Promise<Awaited<ReturnType<typeof run>>> => {
        assertLegacyCommandJoined(result);
        events.push("command-joined");
        joined.resolve();
        await returnResult.promise;
        return { ...result, cleanup: cleanup === "uncertain" ? "uncertain" : result.cleanup };
      });
    });
    vi.spyOn(stateDatabase, "closeOpenClawStateDatabase").mockImplementation(() => {
      expect(leaseStore().read(root).kind).toBe("absent");
      expect(leaseStore().read(childKey).kind).toBe("absent");
      events.push("database-closed");
      closeDatabase();
    });
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (String(target) === scratch) {
        expect(events).toEqual(["command-joined", "database-closed"]);
        events.push("inputs-removed");
      }
      await remove(target, options);
    });
    const body = runLegacyFinalizationScenario("revoked", signal);
    const outcome = body.catch((error: unknown) => error);
    let drain: Promise<void> | undefined;
    let drained = false;
    try {
      await Promise.race([
        ready.promise,
        body.then(() => {
          throw new Error("Legacy fixture ended before child readiness");
        }),
      ]);
      expect(identity).toBeDefined();
      expect(inspectNodeWorkerProcessIdentity(identity!)).toBe("live");
      cancellation.abort(reason);
      // This driver is outside fixture.run: teardown must wait for the actual
      // scenario continuation, not await itself or only the command's exit.
      drain = fixture.cleanup().then(() => {
        drained = true;
      });
      void drain.catch(() => {});
      await Promise.race([joined.promise, body]);
      expect(inspectNodeWorkerProcessIdentity(identity!)).toBe("dead");
      expect(events).toEqual(["command-joined"]);
      expect(drained).toBe(false);
      expect(fs.existsSync(scratch)).toBe(true);
      expect(leaseStore().read(root).kind).toBe("current");
      expect(leaseStore().read(childKey).kind).toBe("current");
      returnResult.resolve();
      if (cleanup === "uncertain") {
        await expect(body).rejects.toThrow("Legacy finalizer process cleanup is unverified");
        await expect(drain).rejects.toThrow("Fixture cleanup unverified");
        expect(events).toEqual(["command-joined"]);
        expect(fs.existsSync(scratch)).toBe(true);
        expect(leaseStore().read(root).kind).toBe("current");
        expect(leaseStore().read(childKey).kind).toBe("current");
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      } else {
        expect(await outcome).toBe(reason);
        await drain;
        expect(events).toEqual(["command-joined", "database-closed", "inputs-removed"]);
        expect(fs.existsSync(scratch)).toBe(false);
        expect(() => owner.assertReleased()).not.toThrow();
      }
    } finally {
      try {
        unblock();
        const result = await command;
        assertLegacyCommandJoined(result);
        await outcome;
        await (drain ?? fixture.cleanup()).catch(() => {});
        // Only the injected uncertainty is rescued: the real command above
        // has joined. Never delete another owner's retained or live inputs.
        if (scratch && fs.existsSync(scratch)) {
          for (const key of [childKey, root]) {
            const row = leaseStore().read(key);
            if (row.kind === "current") {
              leaseStore().release(row.lease);
            }
          }
        }
        closeDatabase();
        fs.rmSync(namespace, { recursive: true, force: true });
      } finally {
        contextSignal.removeEventListener("abort", unblock);
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }
  },
);
