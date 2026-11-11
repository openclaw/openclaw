import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import {
  brokerSpawnPreload,
  signalFixturePid,
  startPreloadedBroker,
} from "./broker-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32").each(["native", "execa"] as const)(
  "cleans an unpublished non-detached %s child after broker death",
  async (transport) => {
    const directory = tempDirs.make("openclaw-broker-group-");
    const marker = path.join(directory, "child.json");
    const preload = path.join(directory, "crash.mjs");
    await writeFile(
      preload,
      brokerSpawnPreload(
        `if (args[0] === '/bin/sleep' && args[1]?.[0] === '30' && child.pid) {
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
            }`,
        "const {writeFileSync} = await import('node:fs');",
      ),
    );
    const host = await startPreloadedBroker(preload);
    const options = { detached: false, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } } as const;
    const child =
      transport === "native"
        ? host.spawn("/bin/sleep", ["30"], options)
        : host.spawnExeca(["/bin/sleep", "30"], { ...options, reject: false }).child;
    const failure = await child.ready().then(
      () => undefined,
      (error: unknown) => error,
    );
    const recorded = JSON.parse(await readFile(marker, "utf8"));
    const childPid: number | undefined = recorded.childPid;
    onTestFinished(() => {
      if (childPid && !isPidDefinitelyDead(childPid)) {
        signalFixturePid(childPid);
      }
    });
    expect(childPid).toBeTypeOf("number");
    expect(recorded.childPgid).toBe(recorded.brokerPgid);
    expect(child.pid).toBeUndefined();
    expect(failure).toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
    await host.close();
    expect(isPidDefinitelyDead(childPid!)).toBe(true);
    expect(recorded.brokerPgid).toBe(recorded.brokerPid);
  },
);
