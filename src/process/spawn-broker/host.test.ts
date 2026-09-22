import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { spawnWithFallback } from "../spawn-utils.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import { SpawnBrokerError } from "./protocol.js";

let broker: SpawnBrokerHost | undefined;
afterEach(async () => {
  await broker?.close();
  broker = undefined;
});

async function start() {
  broker = createSpawnBrokerHost();
  await broker.ready();
  return broker;
}

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker native transport", () => {
  it("runs process commands outside the Gateway process", async () => {
    const host = await start();
    const argv0 = "openclaw-broker-command";
    const args = [
      "-e",
      "process.stdout.write(JSON.stringify({parent:process.ppid,argv0:process.argv0}))",
    ];
    const child = host.spawn(process.execPath, args, {
      argv0,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await child.ready();
    expect(child.spawnfile).toBe(process.execPath);
    expect(child.spawnargs).toEqual([argv0, ...args]);
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    await once(child, "close");
    expect(JSON.parse(stdout)).toEqual({ parent: host.pid, argv0 });
    expect(host.pid).not.toBe(process.pid);
  });

  it("preserves completion listeners installed after readiness when IPC messages arrive together", async () => {
    const host = await start();
    const executable = process.platform === "darwin" ? "/usr/bin/true" : "/bin/true";
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const child = host.spawn(executable, [], { stdio: "ignore" });
      // Let the request leave, then model a busy Gateway while the broker completes it.
      await Promise.resolve();
      const resumeAt = performance.now() + 20;
      while (performance.now() < resumeAt) {
        /* Keep the receiving event loop occupied. */
      }
      await child.ready();
      await Promise.resolve();
      await Promise.resolve();
      const [code] = await once(child, "close", { signal: AbortSignal.timeout(1000) });
      expect(code).toBe(0);
    }
  });

  it.each(["coalesced", "later"])(
    "preserves native spawn waiters and single ordered events for %s exits",
    async (timing) => {
      const host = await start();
      const argv =
        timing === "coalesced"
          ? [process.platform === "darwin" ? "/usr/bin/true" : "/bin/true"]
          : [process.execPath, "-e", "setTimeout(()=>process.exit(0),50)"];
      const starting = runWithSpawnBroker(host, () =>
        spawnWithFallback({ argv, options: { stdio: "ignore" } }),
      );
      await Promise.resolve();
      if (timing === "coalesced") {
        const resumeAt = performance.now() + 20;
        while (performance.now() < resumeAt) {
          /* Batch the broker's native lifecycle messages. */
        }
      }
      const { child } = await starting;
      await Promise.resolve();
      await Promise.resolve();
      const events: string[] = [];
      child.on("exit", () => {
        events.push("exit");
      });
      child.on("close", () => {
        events.push("close");
      });
      expect(child.exitCode).toBe(null);
      const [code] = await once(child, "close", { signal: AbortSignal.timeout(1000) });
      await delay(0);
      expect(code).toBe(0);
      expect(child.exitCode).toBe(0);
      expect(events).toEqual(["exit", "close"]);
    },
  );

  it("preserves independent large output streams and stdin", async () => {
    const host = await start();
    const size = 2 * 1024 * 1024 + 137;
    const child = host.spawn(
      process.execPath,
      [
        "-e",
        `
      process.stdin.resume(); let input = '';
      process.stdin.on('data', x => input += x);
      process.stdin.on('end', () => {
        process.stdout.write(input + 'o'.repeat(${size}));
        process.stderr.write('e'.repeat(${size}));
      });
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await child.ready();
    let stdout = "",
      stderr = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin!.end("input-prefix:");
    await once(child, "close");
    expect(stdout).toBe("input-prefix:" + "o".repeat(size));
    expect(stderr).toBe("e".repeat(size));
  });

  it("preserves real inherited stdin across the host and broker", async () => {
    const input = "inherited-input:".repeat(32_000);
    for (const brokered of [false, true]) {
      const script = `
        import {spawn} from 'node:child_process';
        import {once} from 'node:events';
        import {createSpawnBrokerHost} from ${JSON.stringify(new URL("./host.js", import.meta.url).href)};
        const broker = ${brokered} ? createSpawnBrokerHost() : undefined;
        await broker?.ready();
        const args = ['-e','process.stdin.pipe(process.stdout)'];
        const options = {stdio:['inherit','pipe','pipe']};
        const child = broker ? broker.spawn(process.execPath,args,options) : spawn(process.execPath,args,options);
        if (broker) await child.ready();
        child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
        await once(child,'close'); await broker?.close();
      `;
      const fixture = spawn(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      fixture.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      fixture.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      fixture.stdin.end(input);
      const [code] = await once(fixture, "close");
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe(input);
    }
  });

  it("forwards child IPC and retains separate extra pipes", async () => {
    const host = await start();
    const child = host.spawn(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs');
      process.on('message', value => {
        fs.writeSync(3, 'private-pipe');
        process.send(value, () => process.disconnect());
      });
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"] },
    );
    await child.ready();
    let extra = "";
    child.stdio[3]!.on("data", (chunk) => {
      extra += chunk;
    });
    const message = once(child, "message");
    const closed = once(child, "close");
    await new Promise<void>((resolve, reject) => {
      child.send({ hello: "broker" }, (error) => (error ? reject(error) : resolve()));
    });
    expect((await message)[0]).toEqual({ hello: "broker" });
    await closed;
    expect(extra).toBe("private-pipe");
    expect(child.connected).toBe(false);
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "keeps command completion and cleanup spawning available after a supervisor %s",
    async (signal) => {
      const host = await start();
      const brokerPid = host.pid!;
      const child = host.spawn(
        process.execPath,
        [
          "-e",
          `
          process.on('message', () => {
            process.send('completed', () => process.disconnect());
          });
          process.send('ready');
        `,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      await child.ready();
      expect((await once(child, "message"))[0]).toBe("ready");

      process.kill(brokerPid, signal);
      const [message, closed] = await Promise.all([
        once(child, "message"),
        once(child, "close"),
        new Promise<void>((resolve, reject) => {
          child.send("finish", (error) => (error ? reject(error) : resolve()));
        }),
      ]);
      expect(message[0]).toBe("completed");
      expect(closed).toEqual([0, null]);

      const cleanup = host.spawn(
        process.execPath,
        ["-e", "process.stdout.write(String(process.ppid))"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      await cleanup.ready();
      let output = "";
      cleanup.stdout!.on("data", (chunk) => {
        output += chunk;
      });
      expect(await once(cleanup, "close")).toEqual([0, null]);
      expect(Number(output)).toBe(brokerPid);
      expect(host.pid).toBe(brokerPid);
    },
    15_000,
  );

  it("cleans a detached descendant after its root exits and the host disconnects", async () => {
    const host = await start();
    const child = host.spawn(
      process.execPath,
      [
        "-e",
        `
      const {spawn}=require('node:child_process');
      const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      process.stdout.write(String(descendant.pid),()=>process.exit(0));
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    await child.ready();
    const pidOutput = once(child.stdout!, "data");
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    await Promise.all([once(child, "exit"), pidOutput]);
    const descendant = Number(stdout);
    try {
      await host.close();
      const running = async () => {
        try {
          process.kill(descendant, 0);
          if (process.platform === "linux") {
            const stat = await readFile(`/proc/${descendant}/stat`, "utf8");
            return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
          }
          return true;
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "ESRCH" ||
            (error as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            return false;
          }
          throw error;
        }
      };
      const deadline = Date.now() + 1000;
      while ((await running()) && Date.now() < deadline) {
        await delay(25);
      }
      expect(await running()).toBe(false);
    } finally {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {}
    }
  }, 15_000);

  it("fails in-flight commands on broker loss and restarts without local spawning", async () => {
    const host = await start();
    const previousPid = host.pid!;
    const child = host.spawn(
      process.execPath,
      [
        "-e",
        `
      let stopping = false;
      process.on('SIGTERM', () => {
        if (!stopping) {
          stopping = true;
          setTimeout(() => process.exit(0), 2000);
        }
      });
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await child.ready();
    expect(String((await once(child.stdout!, "data"))[0])).toBe("ready");
    const facts = {
      childPid: child.pid!,
      childStartIdentity: getFileLockProcessStartTime(child.pid!),
      lossReason: "not observed",
      cleanupSettled: false,
    };
    const failure = new Promise<Error>((resolve) => {
      child.once("error", resolve);
    });
    try {
      process.kill(previousPid, "SIGKILL");
      const loss = await failure;
      facts.lossReason =
        loss.cause instanceof Error ? `${loss.message}: ${loss.cause.message}` : loss.message;
      expect(loss, JSON.stringify(facts)).toBeInstanceOf(SpawnBrokerError);
      await expect(
        host.waitForCleanup().then(() => {
          facts.cleanupSettled = true;
        }),
        JSON.stringify(facts),
      ).resolves.toBeUndefined();
      expect(isPidDefinitelyDead(facts.childPid), JSON.stringify(facts)).toBe(true);
      await host.ready();
      expect(host.pid, JSON.stringify(facts)).not.toBe(previousPid);
      const next = host.spawn(
        process.execPath,
        ["-e", "process.stdout.write(String(process.ppid))"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await next.ready();
      let stdout = "";
      next.stdout!.on("data", (chunk) => {
        stdout += chunk;
      });
      await once(next, "close");
      expect(Number(stdout), JSON.stringify(facts)).toBe(host.pid);
    } finally {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {}
    }
  });
});
