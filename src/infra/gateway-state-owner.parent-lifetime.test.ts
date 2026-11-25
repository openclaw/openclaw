import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { CLI_PARENT_BOUND_PRELOAD } from "../../cli-parent-lifetime.mjs";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.for(["independent", "preload", "env"] as const)(
  "launcher exit preserves independent migration or settles %s maintenance",
  async (transport, { signal }) => {
    const bound = transport !== "independent";
    const root = dirs.make("openclaw-parent-lifetime-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const ownerUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.gatewayStateOwner);
    const source = `
      import fs from "node:fs";
      import { DatabaseSync } from "node:sqlite";
      import { watchCliRespawnParent } from ${JSON.stringify(new URL("../../cli-parent-lifetime.mjs", import.meta.url).href)};
      import { acquireGatewayStateOwner } from ${JSON.stringify(ownerUrl.href)};
      watchCliRespawnParent();
      const owner = acquireGatewayStateOwner({ databasePath: ${JSON.stringify(databasePath)} });
      if (Boolean(JSON.parse(fs.readFileSync(owner.path, "utf8")).parentPid) !== ${bound}) throw new Error("Wrong producer lifetime");
      const db = new DatabaseSync(${JSON.stringify(databasePath)});
      db.exec("CREATE TABLE witness(value TEXT); BEGIN; INSERT INTO witness VALUES ('complete')");
      let disconnected = false;
      let settled = false;
      const initialStamp = fs.statSync(owner.path).mtimeMs;
      const watch = fs.watch(owner.path, () => {
        // A real renewal after launcher death proves the detached driver retains custody.
        if (disconnected && !${bound} && fs.statSync(owner.path).mtimeMs > initialStamp) settle(false);
      });
      function settle(rollback) {
        if (settled) return;
        settled = true;
        owner.assertCurrent();
        db.exec(rollback ? "ROLLBACK" : "COMMIT");
        db.close();
        watch.close();
        owner.release();
      }
      process.once("SIGTERM", () => settle(true));
      process.once("disconnect", () => { disconnected = true; });
      process.send(process.pid);
    `;
    const executable = resolveTestNodeExecPath();
    const childArgs = [
      ...resolveRuntimeWorkerArgv(ownerUrl, executable).slice(0, -1),
      ...(transport === "preload" ? ["--import", CLI_PARENT_BOUND_PRELOAD] : []),
      "--input-type=module",
      "-e",
      source,
    ];
    const launcherPath = path.join(root, "launcher.mjs");
    fs.writeFileSync(
      launcherPath,
      `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [...process.execArgv, ...${JSON.stringify(childArgs)}], {
        detached: ${!bound}, stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, ...(${transport === "env"} ? { OPENCLAW_CLI_RESPAWN_PARENT: String(process.pid) } : {}) },
      });
      child.once("message", pid => { process.send(pid); process.exit(0); });
    `,
    );
    const launcher = spawn(executable, ["--import", CLI_PARENT_BOUND_PRELOAD, launcherPath], {
      env: { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const closed = once(launcher, "close");
    let stderr = "";
    let ownerPid: number | undefined;
    launcher.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      [ownerPid] = await withinTest(once(launcher, "message"), signal);
      expect(await withinTest(closed, signal), stderr).toEqual([0, null]);
      using db = new DatabaseSync(databasePath);
      expect(db.prepare("SELECT value FROM witness").all()).toEqual(
        bound ? [] : [{ value: "complete" }],
      );
      acquireGatewayStateOwner({ databasePath }).release();
    } finally {
      try {
        killPidIfAlive(ownerPid);
      } finally {
        if (launcher.exitCode === null && launcher.signalCode === null) {
          launcher.kill("SIGKILL");
        }
        await closed;
      }
    }
  },
);
