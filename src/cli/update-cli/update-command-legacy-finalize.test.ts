import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabase());

it.each([
  "state-migrated-no-rollback",
  "rollback-state-unverified",
  "revoked",
  "retargeted",
  "grantless",
  "grantless-incumbent",
] as const)(
  "shipped legacy grant completes migrated finalization and native restart: %s",
  async (scenario) => {
    const scratch = fs.realpathSync(dirs.make("legacy-native-finalize-"));
    const root = fs.realpathSync(process.cwd());
    const configPath = path.join(scratch, "openclaw.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: scratch,
      USERPROFILE: scratch,
      OPENCLAW_HOME: scratch,
      OPENCLAW_STATE_DIR: scratch,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_TEST_RUNTIME_LOG: "1",
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
    const databasePath = path.join(scratch, "managed-update-handoffs.sqlite");
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
    const owner = new URL("../daemon-cli/update-executor.ts", import.meta.url).href;
    const exec = new URL("../../daemon/exec-file.ts", import.meta.url).href;
    fs.writeFileSync(
      entry,
      `
      await import(${JSON.stringify(loader)});
      const fs=await import("node:fs");
      const {DatabaseSync}=await import("node:sqlite");
      const {runGatewayServiceUpdateCommand}=await import(${JSON.stringify(owner)});
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
    if (scenario === "grantless") {
      expect(store.release(bound)).toBe(true);
      expect(store.release(acquired.lease)).toBe(true);
    }
    const input = {
      ...(grantless ? {} : { executor }),
      bufferedSteps: [],
      resultPath: path.join(scratch, "result.json"),
      params: {
        root,
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
          env,
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
      if (scenario === "grantless-incumbent") {
        expect(result.code, details).not.toBe(0);
        expect(fs.existsSync(path.join(scratch, "receiver-pid"))).toBe(false);
        expect(store.current(acquired.lease)).toBe(true);
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
    } finally {
      store.release(bound);
      store.release(acquired.lease);
    }
  },
  90000,
);
