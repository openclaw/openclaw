import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { createSpawnBrokerHost } from "./host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker process-group custody", () => {
  it.each(["native", "execa"] as const)(
    "cleans an unpublished non-detached %s child after broker death",
    async (transport) => {
      const directory = tempDirs.make("openclaw-broker-group-");
      const marker = path.join(directory, "child.json");
      const preload = path.join(directory, "crash.mjs");
      await writeFile(
        preload,
        `
        import childProcess from 'node:child_process';
        import {writeFileSync} from 'node:fs';
        import {syncBuiltinESMExports} from 'node:module';
        if (/\\/spawn-broker\\/worker\\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
          const nativeSpawn = childProcess.spawn;
          childProcess.spawn = function(...args) {
            const child = nativeSpawn.apply(this,args);
            if (args[0] === '/bin/sleep' && args[1]?.[0] === '30' && child.pid) {
              try {
                const probe = childProcess.spawnSync('/bin/ps', ['-o','pid=,pgid=','-p',process.pid+','+child.pid], {encoding:'utf8'});
                if (probe.status !== 0) throw new Error('group probe failed');
                const rows = probe.stdout.trim().split('\\n').map(line=>line.trim().split(/\\s+/).map(Number));
                writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
                  brokerPid:process.pid, childPid:child.pid,
                  brokerPgid:rows.find(row=>row[0]===process.pid)?.[1],
                  childPgid:rows.find(row=>row[0]===child.pid)?.[1],
                }), {flag:'wx',mode:0o600});
              } catch(error) {child.kill('SIGKILL');throw error;}
              process.kill(process.pid,'SIGKILL');
            }
            return child;
          };
          syncBuiltinESMExports();
        }
      `,
      );
      const previousNodeOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = `${previousNodeOptions ?? ""} --import=${pathToFileURL(preload).href}`;
      const host = createSpawnBrokerHost();
      let childPid: number | undefined;
      try {
        try {
          await host.ready();
        } finally {
          if (previousNodeOptions === undefined) {
            delete process.env.NODE_OPTIONS;
          } else {
            process.env.NODE_OPTIONS = previousNodeOptions;
          }
        }
        const child =
          transport === "native"
            ? host.spawn("/bin/sleep", ["30"], {
                detached: false,
                stdio: "ignore",
                env: { PATH: "/usr/bin:/bin" },
              })
            : host.spawnExeca(["/bin/sleep", "30"], {
                detached: false,
                stdio: "ignore",
                reject: false,
                env: { PATH: "/usr/bin:/bin" },
              }).child;
        const failure = await child.ready().then(
          () => undefined,
          (error: unknown) => error,
        );
        const recorded = JSON.parse(await readFile(marker, "utf8"));
        childPid = recorded.childPid;
        expect(childPid).toBeTypeOf("number");
        expect(recorded.childPgid).toBe(recorded.brokerPgid);
        expect(child.pid).toBeUndefined();
        expect(failure).toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
        await host.close();
        expect(isPidDefinitelyDead(childPid!)).toBe(true);
        expect(recorded.brokerPgid).toBe(recorded.brokerPid);
      } finally {
        if (previousNodeOptions === undefined) {
          delete process.env.NODE_OPTIONS;
        } else {
          process.env.NODE_OPTIONS = previousNodeOptions;
        }
        if (childPid && !isPidDefinitelyDead(childPid)) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {}
        }
        await host.close();
      }
    },
  );
});
