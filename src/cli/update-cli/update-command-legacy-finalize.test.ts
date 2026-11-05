import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
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
import { finishParams, updateResult } from "./update-command-maintenance-fixtures.test-support.js";

// Cancellation ends Vitest's wrapper before the body joins; retain its inputs.
const fixture = createFixtureLifetime();
const testNodeExecPath = resolveTestNodeExecPath();
type LegacyCommand = ReturnType<typeof commandRunner.runUtf8CommandWithTimeout>;
afterEach(() => fixture.cleanup());

function tempEnvironment(directory: string) {
  return { TMPDIR: directory, TMP: directory, TEMP: directory };
}

function legacyEnvironment(scratch: string) {
  const configPath = path.join(scratch, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
  return {
    ...process.env,
    HOME: scratch,
    USERPROFILE: scratch,
    OPENCLAW_HOME: scratch,
    OPENCLAW_STATE_DIR: scratch,
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

function runLegacyCommand(options: commandRunner.CommandOptions, check = false) {
  return commandRunner.runUtf8CommandWithTimeout(
    [
      testNodeExecPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(legacyFinalizeEntrypoint),
        testNodeExecPath,
      ),
      JSON.stringify(runtimeProcessEntrypoints.sqliteReadOnly),
      ...(check ? ["--check"] : []),
    ],
    {
      baseEnv: {},
      cwd: process.cwd(),
      timeoutMs: 60_000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      ...options,
    },
  );
}

async function closeLegacyFixture(command: LegacyCommand | undefined, release: () => void) {
  await fixture.verifyCleanup(async () => {
    assertLegacyCommandJoined(await command);
    release();
    stateDatabase.closeOpenClawStateDatabase();
  });
}

function assertLegacyCommandJoined(result: Awaited<LegacyCommand> | undefined) {
  if (result?.cleanup === "uncertain") {
    const { stdout, stderr, ...processResult } = result;
    throw new Error("Legacy finalizer process cleanup is unverified", {
      cause: {
        ...processResult,
        stdoutTail: stdout.slice(-8192),
        stderrTail: stderr.slice(-8192),
      },
    });
  }
}

const scenarios = [
  "rollback-state-unverified",
  "revoked",
  "retargeted",
  "grantless-scratch",
  "grantless-scratch-incumbent",
  "grantless-scratch-owned",
  "grantless-scratch-owned-incumbent",
  "grantless-scratch-owned-parent-git",
  "grantless-scratch-owned-parent-completed",
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

it("validates migrated finalizer capabilities", { timeout: 90_000 }, ({ signal }) =>
  fixture.run(async () => {
    signal.throwIfAborted();
    const scratch = fs.realpathSync(fixture.createTempDir("legacy-native-check-"));
    let command: LegacyCommand | undefined;
    try {
      command = runLegacyCommand(
        { env: { ...legacyEnvironment(scratch), ...tempEnvironment(scratch) }, signal },
        true,
      );
      const result = await command;
      assertLegacyCommandJoined(result);
      signal.throwIfAborted();
      const details = result.stderr + "\n" + result.stdout;
      expect(result, details).toMatchObject({ termination: "exit", code: 0 });
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
    const file = (name: string) => path.join(scratch, name);
    const exists = (name: string) => fs.existsSync(file(name));
    const read = (name: string) => fs.readFileSync(file(name), "utf8");
    const endsWith = (suffix: string) => scenario.endsWith(suffix);
    const root = fs.realpathSync(process.cwd());
    const switchedRoot = endsWith("-git-root-switch");
    const movedRoot = switchedRoot || endsWith("-pnpm-root-move");
    const parentRoot = movedRoot ? file("previous-installation") : root;
    const candidateRoot = movedRoot ? file("candidate-installation") : root;
    if (movedRoot) {
      fs.mkdirSync(parentRoot);
      fs.mkdirSync(candidateRoot);
      fs.writeFileSync(
        path.join(candidateRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.4", type: "module" }),
      );
    }
    const scratchTemp = scenario.includes("-scratch");
    const ownedTemp = scenario.includes("-owned");
    const incumbent = endsWith("-incumbent");
    const legacyParent = scenario.includes("-parent-");
    const completed = endsWith("-completed");
    const refusedParent = scenario.includes("-wrong-") || endsWith("-registered-child");
    const normalTemp = file("normal-temp");
    const workerTemp = file("openclaw-update-migrated-fixture");
    const unsafePreferred = file("unavailable-preferred");
    if (scratchTemp) {
      fs.mkdirSync(normalTemp);
      fs.mkdirSync(workerTemp);
      // Force POSIX fallback without touching /tmp/openclaw; Windows skips preferredDir.
      fs.writeFileSync(unsafePreferred, "not a directory");
    }
    const env: NodeJS.ProcessEnv = {
      ...legacyEnvironment(scratch),
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_TEST_RUNTIME_LOG: "1",
      ...(completed && { OPENCLAW_TEST_COMPLETED_TERMINAL: "1" }),
      ...(scratchTemp && {
        ...tempEnvironment(ownedTemp ? workerTemp : normalTemp),
        OPENCLAW_TEST_LEGACY_TEMP_FALLBACK: "1",
      }),
    };
    for (const name of [
      "OPENCLAW_SERVICE_KIND",
      "OPENCLAW_SERVICE_MARKER",
      "OPENCLAW_SERVICE_REPAIR_POLICY",
    ]) {
      delete env[name];
    }
    let command: LegacyCommand | undefined;
    let releaseParent: (() => void) | undefined;
    let releaseChild: (() => void) | undefined;
    try {
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      if (legacyParent) {
        env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
        env.OPENCLAW_UPDATE_RUN_ID = runId;
      }
      const originalEnv = ownedTemp ? { ...env, ...tempEnvironment(normalTemp) } : env;
      const leaseDirectory = scratchTemp
        ? resolvePreferredOpenClawTmpDir({
            preferredDir: unsafePreferred,
            tmpdir: () => normalTemp,
          })
        : scratch;
      const databasePath = path.join(leaseDirectory, "managed-update-handoffs.sqlite");
      const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: env });
      const acquired = store.acquire(parentRoot, randomUUID(), { kind: "update" });
      assert(acquired.kind === "acquired", "Missing original owner");
      let parentLease = acquired.lease;
      releaseParent = () => store.release(parentLease);
      // v2026.9.4 (3a9d69db) predates lineage/database pins: use its exact producer format.
      const child = store.acquire(`${parentRoot}/.openclaw-update-child-${randomUUID()}`, runId, {
        kind: "update",
      });
      assert(child.kind === "acquired", "Missing legacy child");
      let bound = child.lease;
      releaseChild = () => store.release(bound);
      const executor = {
        runId,
        root,
        databasePath,
        parent: acquired.lease,
        childKey: child.lease.key,
      };
      const entry = file("native-entry.mjs");
      const loader = path.resolve("scripts/tsx.mjs");
      const owner = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExecutor);
      const exec = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExec).href;
      const receiverUrl = movedRoot
        ? pathToFileURL(path.join(candidateRoot, `native-receiver${path.extname(owner.pathname)}`))
        : owner;
      if (movedRoot) {
        // Retain the relocated package-root check while sharing the authority scope.
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
      const grantless = scenario.startsWith("grantless");
      if (legacyParent) {
        // v2026.9.3 awaits result.json under its root lease, without a child grant.
        if (!endsWith("-registered-child")) {
          expect(store.release(bound)).toBe(true);
        }
      } else if (grantless && !incumbent) {
        expect(store.release(bound)).toBe(true);
        expect(store.release(acquired.lease)).toBe(true);
      }
      if (switchedRoot) {
        fs.renameSync(parentRoot, file("retained-installation"));
        fs.symlinkSync(
          candidateRoot,
          parentRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const input = {
        executor: grantless ? undefined : executor,
        bufferedSteps: [],
        resultPath: path.join(legacyParent ? workerTemp : scratch, "result.json"),
        params: finishParams({
          root: parentRoot,
          ownedManagedUpdateEnv: ownedTemp ? originalEnv : undefined,
          installKindChanged: switchedRoot,
          configSnapshot: createTestConfigSnapshot({}, {}, env.OPENCLAW_CONFIG_PATH),
          opts: { json: true, yes: true, run: { runId, env } },
          result: updateResult({
            after: completed
              ? { version: "2026.9.5", buildId: "verified-migrated-candidate" }
              : undefined,
            mode: switchedRoot || endsWith("-git") ? "git" : movedRoot ? "pnpm" : "npm",
            before: legacyParent
              ? { version: endsWith("-wrong-version") ? "2026.9.4" : "2026.9.3" }
              : undefined,
            root: candidateRoot,
            durationMs: 0,
          }),
          controlPlaneUpdateSentinelMeta: legacyParent
            ? {
                runId: endsWith("-wrong-run") ? randomUUID() : runId,
                handoffId: endsWith("-wrong-handoff") ? randomUUID() : acquired.lease.owner,
                root: endsWith("-wrong-root") ? path.join(root, "other-installation") : parentRoot,
              }
            : null,
          packageUpdateNodeRunner: testNodeExecPath,
          updateStepTimeoutMs: 20000,
          rollbackBlockedReason:
            scenario === "rollback-state-unverified" ? scenario : "state-migrated-no-rollback",
        }),
      };
      command = runLegacyCommand({
        input: JSON.stringify(input),
        cwd: root,
        env: scratchTemp
          ? {
              ...originalEnv,
              ...tempEnvironment(workerTemp),
              TMP: endsWith("-wrong-scratch") ? normalTemp : workerTemp,
            }
          : env,
        signal,
        beforeInput(pid) {
          if (endsWith("-wrong-parent")) {
            const reassigned = store.bind(parentLease, pid);
            assert(reassigned, "Parent reassignment failed");
            parentLease = reassigned;
          }
          if (grantless) {
            return;
          }
          const registered = store.bind(child.lease, pid);
          assert(registered, "Legacy binding failed");
          bound = registered;
        },
      });
      const result = await command;
      assertLegacyCommandJoined(result);
      signal.throwIfAborted();
      const details = result.stderr + "\n" + result.stdout;
      expect(result.termination, details).toBe("exit");
      if (incumbent || refusedParent) {
        expect(result.code, details).not.toBe(0);
        expect(["receiver-pid", "native-effect"].map(exists)).toEqual([false, false]);
        expect(store.current(parentLease)).toBe(true);
        expect(fs.existsSync(input.resultPath)).toBe(false);
        expect(getUpdateRun(runId, { env })?.status).toBe("running");
      } else if (endsWith("revoked") || endsWith("retargeted")) {
        expect(["receiver-pid", "native-effect"].map(exists), details).toEqual([true, false]);
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
        expect(read("native-effect")).toBe("restarted");
        const receiver = JSON.parse(read("receiver-pid"));
        expect(receiver.parent).toBe(Number(read("finalizer-pid")));
        expect(receiver.pid).not.toBe(receiver.parent);
        expect(getUpdateRun(runId, { env })).toMatchObject({ status: "succeeded" });
        if (legacyParent) {
          expect(store.current(acquired.lease)).toBe(true);
          expect(store.hasUnsettledChildren(acquired.lease)).toBe(false);
        } else if (!grantless) {
          expect(store.release(bound)).toBe(true);
        }
        if (legacyParent || !grantless) {
          expect(store.release(acquired.lease)).toBe(true);
        }
        expect(store.read(parentRoot).kind).toBe("absent");
        expect(store.read(candidateRoot).kind).toBe("absent");
      }
      if (scratchTemp) {
        // Completion and refusal must both avoid a worker-private authority DB.
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
  "joins legacy finalization before releasing inputs (cleanup=%s)",
  async (cleanup, { signal: contextSignal }) => {
    contextSignal.throwIfAborted();
    // Isolate the expected retained claim from the surrounding suite's owner.
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
    let command: LegacyCommand | undefined;
    let output = "";
    const root = fs.realpathSync(process.cwd());
    const leaseStore = () => {
      assert(fixtureEnv, "Legacy fixture command environment was not captured");
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
      assert(typeof options !== "number", "Legacy fixture lost its command options");
      expect(options.signal).toBe(signal);
      fixtureEnv = options.env;
      assert(fixtureEnv, "Legacy fixture lost its command environment");
      scratch = fixtureEnv.OPENCLAW_STATE_DIR!;
      childKey = (JSON.parse(String(options.input)) as { executor: { childKey: string } }).executor
        .childKey;
      // Substitute the payload, retaining real runner/admission/cancellation ownership.
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
      return command.then(async (result): Promise<Awaited<LegacyCommand>> => {
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
      // Outside fixture.run: teardown must join the body, not itself or only the child.
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
        assertLegacyCommandJoined(await command);
        await outcome;
        await (drain ?? fixture.cleanup()).catch(() => {});
        // Rescue only injected uncertainty after the real command has joined.
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
