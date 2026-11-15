import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import { parseGatewayLockPayload } from "./gateway-lock-payload.js";
import { reserveGatewayStateRestoration } from "./gateway-state-owner-record.js";
import {
  acquireGatewayStateOwner,
  acquireStateDatabaseSchemaLease,
} from "./gateway-state-owner.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("prioritizes Gateway bootstrap over an already waiting CLI schema writer", async () => {
  const root = dirs.make("openclaw-gateway-restoration-");
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  const otherPath = path.join(root, "other", "state", "openclaw.sqlite");
  const owner = acquireGatewayStateOwner({ databasePath });
  const ownerUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.gatewayStateOwner);
  let reservation: ReturnType<typeof reserveGatewayStateRestoration> | undefined;
  let childPid: number | undefined;
  try {
    const child = await runNodeScript(
      (workerArgv) => [
        ...workerArgv(ownerUrl).slice(0, -1),
        "--input-type=module",
        "--eval",
        `
        import fs from "node:fs";
        import { acquireStateDatabaseSchemaLease } from ${JSON.stringify(ownerUrl.href)};
        const databasePath = ${JSON.stringify(databasePath)};
        const open = fs.openSync;
        let announced = false;
        fs.openSync = function (pathname, ...args) {
          try { return open.call(this, pathname, ...args); }
          catch (error) {
            if (pathname === ${JSON.stringify(owner.path)} && error.code === "EEXIST" && !announced) {
              announced = true;
              process.stdout.write("waiting\\n");
            }
            throw error;
          }
        };
        function acquire(pathname = databasePath) {
          try {
            const lease = acquireStateDatabaseSchemaLease(pathname, { busyTimeoutMs: 5000 });
            lease.release();
            return "acquired";
          } catch (error) {
            if (error.databasePath === pathname && error.message.startsWith("Gateway restoration has priority")) return "deferred";
            throw error;
          }
        }
        const waiting = acquire();
        fs.openSync = open;
        process.argv = [process.execPath, ${JSON.stringify(path.join(process.cwd(), "openclaw.mjs"))}, "gateway", "status"];
        const status = acquire();
        process.argv = [process.execPath, ${JSON.stringify(path.join(process.cwd(), "openclaw.mjs"))}, "gateway", "--port", "18789"];
        const gateway = acquire();
        process.argv = [process.execPath, ${JSON.stringify(path.join(process.cwd(), "openclaw.mjs"))}, "gateway", "run", "--port", "18789"];
        const explicitRun = acquire();
        process.argv = [process.execPath, ${JSON.stringify(path.join(process.cwd(), "openclaw.mjs"))}, "infer"];
        const unrelated = acquire(${JSON.stringify(otherPath)});
        console.log(JSON.stringify({ waiting, status, gateway, explicitRun, unrelated }));
        `,
      ],
      { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root },
      15_000,
      {
        onReady(childProcess, readOutput) {
          childPid = childProcess.pid;
          childProcess.stdout!.on("data", () => {
            if (!reservation && readOutput().stdout.includes("waiting\n")) {
              reservation = reserveGatewayStateRestoration(databasePath, owner.assertCurrent);
              owner.release();
            }
          });
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim().split("\n").at(-1)).toBe(
      JSON.stringify({
        waiting: "deferred",
        status: "deferred",
        gateway: "acquired",
        explicitRun: "acquired",
        unrelated: "acquired",
      }),
    );
    expect(reservation).toBeDefined();
    reservation!.assertCurrent();
    const local = acquireStateDatabaseSchemaLease(databasePath);
    local.release();
    const reservationPath = `${owner.path}.gateway-restoration`;
    const record = parseGatewayLockPayload(fs.readFileSync(reservationPath, "utf8"));
    reservation!.release();
    expect(() => reservation!.assertCurrent()).toThrow("no longer current");
    expect(() => reserveGatewayStateRestoration(databasePath, owner.assertCurrent)).toThrow(
      "no longer current",
    );
    // A positively exited holder cannot leave the startup priority reserved.
    fs.writeFileSync(reservationPath, JSON.stringify({ ...record, pid: childPid }));
    const abandoned = acquireStateDatabaseSchemaLease(databasePath);
    abandoned.release();
  } finally {
    owner.release();
    reservation?.release();
  }
});
