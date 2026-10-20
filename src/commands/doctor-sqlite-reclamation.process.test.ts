import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { expect, it } from "vitest";
import { doctorOutputEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createNodeEvalArgs, resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it.skipIf(process.platform === "win32")(
  "settles admitted SQLite work before queued SIGTERM exits Doctor",
  async () => {
    await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
      const agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const shared = resolveOpenClawStateSqlitePath(state.env);
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      await closeOpenClawStateDatabaseAsync();
      for (const pathname of [shared, agent.path]) {
        const database = openNodeSqliteDatabase(pathname);
        database.exec(
          "PRAGMA auto_vacuum=NONE; VACUUM; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('signal preserved');",
        );
        database.close();
      }
      const untouched = fs.readFileSync(agent.path);
      const registrar = resolveRuntimeWorkerUrl(doctorOutputEntrypoints.maintenance);
      const eventsPath = state.path("signal-events.json");
      const script = `
      import fs from "node:fs";
      const { beginDoctorMaintenance } = await import(${JSON.stringify(new URL("../../commands/doctor-maintenance.js", registrar).href)});
      const { installCliSignalExitHandlers, registerSignalExitBarrier } = await import(${JSON.stringify(new URL("../signal-exit-barrier.js", registrar).href)});
      installCliSignalExitHandlers();
      const events = [];
      const record = event => { events.push({ ...event, at: Date.now(), pid: process.pid }); fs.writeFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(events)); };
      let signalled = false;
      registerSignalExitBarrier(async () => { record({ event: "exit-barrier" }); });
      const maintenance = await beginDoctorMaintenance({
        root: null, options: { repair: true, nonInteractive: true },
        runtime: { log(message) {
          if (message.startsWith("Enabling incremental") && !signalled) {
            signalled = true;
            record({ event: "queued-SIGTERM", phase: "admitted-conversion", pathname: ${JSON.stringify(shared)} });
            process.kill(process.pid, "SIGTERM");
          } else if (message.startsWith("Enabled incremental")) {
            record({ event: "verified-conversion", message });
          }
        }, error: console.error, exit(code) { throw new Error("Unexpected runtime exit " + code); } },
      });
      if (!maintenance) throw new Error("Doctor did not acquire maintenance");
      try {
        await maintenance.enableSqliteReclamation([{ agentId: "main", path: ${JSON.stringify(agent.path)}, realPath: ${JSON.stringify(agent.path)}, source: "configured" }]);
        throw new Error("Expected queued signal to stop later admission");
      } catch (error) {
        record({ event: "interrupted", aborted: maintenance.signal.aborted, message: String(error) });
        if (!maintenance.signal.aborted) throw error;
      } finally { await maintenance.release(); }
    `;
      const child = spawn(resolveTestNodeExecPath(), createNodeEvalArgs(script), {
        env: {
          ...state.env,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          OPENCLAW_UPDATE_RUN_ID: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        killSignal: "SIGKILL",
      });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const closed = once(child, "close");
      try {
        const [code, signal] = await closed;
        expect({ code, signal }, stderr).toEqual({ code: 143, signal: null });
        const events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
        expect(events.map((entry: { event: string }) => entry.event)).toEqual([
          "queued-SIGTERM",
          "verified-conversion",
          "interrupted",
          "exit-barrier",
        ]);
        expect(events[2]).toMatchObject({ aborted: true });
        expect(events[0].pid).toBe(child.pid);
        expect(events[0].at).toBeLessThanOrEqual(events[1].at);
        expect(fs.readFileSync(agent.path)).toEqual(untouched);
        const database = openNodeSqliteDatabase(shared, { readOnly: true });
        let observed;
        try {
          observed = {
            mode: database.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum,
            integrity: database.prepare("PRAGMA integrity_check").get()?.integrity_check,
            value: database.prepare("SELECT value FROM retained").get()?.value,
          };
          expect(observed).toEqual({ mode: 2, integrity: "ok", value: "signal preserved" });
        } finally {
          database.close();
        }
        const replacement = acquireGatewayStateOwner({ databasePath: shared });
        replacement.release();
        expect(() => process.kill(child.pid!, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
        console.log(
          JSON.stringify({
            observation: "doctor-maintenance-queued-SIGTERM",
            code,
            signal,
            events,
            shared: observed,
            secondDatabaseByteIdentical: true,
            replacementOwnershipAcquired: true,
            childPidAbsent: true,
          }),
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await closed;
      }
    });
  },
);
