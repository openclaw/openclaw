import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabase());

it.each([
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
] as const)(
  "shipped legacy grant completes migrated finalization and native restart: %s",
  async (scenario) => {
    const scratch = fs.realpathSync(dirs.make("legacy-native-finalize-"));
    const root = fs.realpathSync(process.cwd());
    const configPath = path.join(scratch, "openclaw.json");
    const scratchEnvironment = scenario.includes("-scratch");
    const ownedEnvironment = scenario.includes("-owned");
    const incumbent = scenario.endsWith("-incumbent");
    const normalTemp = path.join(scratch, "normal-temp");
    const workerTemp = path.join(scratch, "worker-temp");
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
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
    const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
    const originalEnvironment = ownedEnvironment
      ? { ...env, TMPDIR: normalTemp, TMP: normalTemp, TEMP: normalTemp }
      : env;
    const leaseDirectory = scratchEnvironment
      ? resolvePreferredOpenClawTmpDir({ preferredDir: unsafePreferred, tmpdir: () => normalTemp })
      : scratch;
    const databasePath = path.join(leaseDirectory, "managed-update-handoffs.sqlite");
    const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: env });
    const acquired = store.acquire(root, randomUUID(), { kind: "update" });
    if (acquired.kind !== "acquired") {
      throw new Error("Missing original owner");
    }
    // Exact v2026.9.4 producer format (3a9d69db): real UUID child registration,
    // parent row and private input, with no later lineage or database-pin fields.
    const child = store.acquire(`${root}/.openclaw-update-child-${randomUUID()}`, runId, {
      kind: "update",
    });
    if (child.kind !== "acquired") {
      throw new Error("Missing legacy child");
    }
    let bound = child.lease;
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
    fs.writeFileSync(
      entry,
      `
      ${owner.pathname.endsWith(".ts") ? `await import(${JSON.stringify(loader)});` : ""}
      const fs=await import("node:fs");
      const {DatabaseSync}=await import("node:sqlite");
      const {runGatewayServiceUpdateCommand}=await import(${JSON.stringify(owner.href)});
      const {execFileUtf8}=await import(${JSON.stringify(exec)});
      const mode=process.argv[process.argv.indexOf("--update-executor")+1];
      await runGatewayServiceUpdateCommand(mode,"restart",async()=>{
        fs.writeFileSync(${JSON.stringify(scratch + "/receiver-pid")},JSON.stringify({pid:process.pid,parent:process.ppid}));
        if(${JSON.stringify(scenario)}==="revoked") {
          const db=new DatabaseSync(${JSON.stringify(databasePath)});
          db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run("revoked",${JSON.stringify(root)});db.close();
        }
        if(${JSON.stringify(scenario)}==="retargeted") {
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
    if (grantless && !incumbent) {
      expect(store.release(bound)).toBe(true);
      expect(store.release(acquired.lease)).toBe(true);
    }
    const input = {
      ...(grantless ? {} : { executor }),
      bufferedSteps: [],
      resultPath: path.join(scratch, "result.json"),
      params: {
        root,
        ...(ownedEnvironment ? { ownedManagedUpdateEnv: originalEnvironment } : {}),
        mutationStarted: true,
        installKindChanged: false,
        configSnapshot: snapshot,
        requestedChannel: null,
        storedChannel: "stable",
        channel: "stable",
        downgradeRisk: false,
        shouldRestart: true,
        opts: { json: true, yes: true, run: { runId, env } },
        result: { status: "ok", mode: "npm", root, steps: [], durationMs: 0 },
        controlPlaneUpdateSentinelMeta: null,
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        packageUpdateNodeRunner: process.execPath,
        updateStepTimeoutMs: 20000,
        rollbackBlockedReason:
          scenario === "rollback-state-unverified" ? scenario : "state-migrated-no-rollback",
      },
    };
    try {
      const result = await runUtf8CommandWithTimeout(
        [
          process.execPath,
          "--import",
          loader,
          fileURLToPath(
            new URL("./update-command-legacy-finalize.test-support.ts", import.meta.url),
          ),
        ],
        {
          input: JSON.stringify(input),
          env: scratchEnvironment
            ? { ...originalEnvironment, TMPDIR: workerTemp, TMP: workerTemp, TEMP: workerTemp }
            : env,
          baseEnv: {},
          cwd: root,
          timeoutMs: 60000,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          beforeInput(pid) {
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
      const details = result.stderr + "\n" + result.stdout;
      if (incumbent) {
        expect(result.code, details).not.toBe(0);
        expect(fs.existsSync(path.join(scratch, "receiver-pid"))).toBe(false);
        expect(store.current(acquired.lease)).toBe(true);
        expect(fs.existsSync(path.join(scratch, "native-effect"))).toBe(false);
      } else if (scenario === "revoked" || scenario === "retargeted") {
        expect(fs.existsSync(path.join(scratch, "receiver-pid")), details).toBe(true);
        expect(fs.existsSync(path.join(scratch, "native-effect")), details).toBe(false);
        expect(result.code, details).not.toBe(0);
      } else {
        expect(result.code, details).toBe(0);
        expect(JSON.parse(fs.readFileSync(input.resultPath, "utf8")), details).toMatchObject({
          exitCode: 0,
          terminalRunId: runId,
          result: { status: "ok" },
        });
        expect(fs.readFileSync(path.join(scratch, "native-effect"), "utf8")).toBe("restarted");
        const receiver = JSON.parse(fs.readFileSync(path.join(scratch, "receiver-pid"), "utf8"));
        expect(receiver.parent).toBe(
          Number(fs.readFileSync(path.join(scratch, "finalizer-pid"), "utf8")),
        );
        expect(receiver.pid).not.toBe(receiver.parent);
        expect(getUpdateRun(runId, { env })).toMatchObject({ status: "succeeded" });
        if (!grantless) {
          expect(store.release(bound)).toBe(true);
          expect(store.release(acquired.lease)).toBe(true);
        }
        expect(store.read(root).kind).toBe("absent");
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
      store.release(bound);
      store.release(acquired.lease);
    }
  },
  90000,
);
