import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { doctorOutputEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createNodeEvalArgs } from "../test-utils/node-process.js";
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
        using database = openNodeSqliteDatabase(pathname);
        database.exec(
          "PRAGMA auto_vacuum=NONE; VACUUM; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('signal preserved');",
        );
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
            record({ event: "queued-SIGTERM" });
            process.kill(process.pid, "SIGTERM");
          } else if (message.startsWith("Enabled incremental")) {
            record({ event: "verified-conversion" });
          }
        }, error: console.error, exit(code) { throw new Error("Unexpected runtime exit " + code); } },
      });
      if (!maintenance) throw new Error("Doctor did not acquire maintenance");
      try {
        await maintenance.enableSqliteReclamation([{ agentId: "main", path: ${JSON.stringify(agent.path)}, realPath: ${JSON.stringify(agent.path)}, source: "configured" }]);
        throw new Error("Expected queued signal to stop later admission");
      } catch (error) {
        record({ event: "interrupted", aborted: maintenance.signal.aborted });
        if (!maintenance.signal.aborted) throw error;
      } finally { await maintenance.release(); }
    `;
      let child: ChildProcess | undefined;
      const result = await runNodeScript(
        createNodeEvalArgs(script),
        {
          ...state.env,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          OPENCLAW_UPDATE_RUN_ID: undefined,
        },
        30_000,
        {
          onReady(spawned) {
            child = spawned;
          },
        },
      );
      expect(
        { error: result.error, code: result.status, signal: child?.signalCode },
        result.stderr,
      ).toEqual({ error: undefined, code: 143, signal: null });
      const events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
      expect(events).toMatchObject([
        { event: "queued-SIGTERM", pid: child?.pid },
        { event: "verified-conversion" },
        { event: "interrupted", aborted: true },
        { event: "exit-barrier" },
      ]);
      expect(events[0].at).toBeLessThanOrEqual(events[1].at);
      expect(fs.readFileSync(agent.path)).toEqual(untouched);
      {
        using database = openNodeSqliteDatabase(shared, { readOnly: true });
        const observed = {
          mode: database.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum,
          integrity: database.prepare("PRAGMA integrity_check").get()?.integrity_check,
          value: database.prepare("SELECT value FROM retained").get()?.value,
        };
        expect(observed).toEqual({ mode: 2, integrity: "ok", value: "signal preserved" });
      }
      const replacement = acquireGatewayStateOwner({ databasePath: shared });
      replacement.release();
      expect(() => process.kill(child!.pid!, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    });
  },
);
