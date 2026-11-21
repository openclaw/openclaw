import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { processProbeEntrypoints } from "../process-probes-runtime.test-support.js";
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

it.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch))(
  "closes a broker and stops its children when the kernel denies group signals",
  async () => {
    const fixture = resolveRuntimeWorkerUrl(processProbeEntrypoints.groupCustodyDenied);
    // The scenario needs Node command pipes and runs under the real filter; vitest itself cannot.
    const node = resolveTestNodeExecPath();
    const { stdout } = await promisify(execFile)(node, resolveRuntimeWorkerArgv(fixture, node), {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(JSON.parse(stdout)).toEqual({
      closed: "closed",
      attachedDead: true,
      descendantDead: true,
    });
  },
  25_000,
);
