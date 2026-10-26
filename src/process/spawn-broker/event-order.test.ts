import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import {
  brokerSpawnPreload,
  signalFixturePid,
  startPreloadedBroker,
} from "./broker-fixture.test-support.js";
import { BrokerChild } from "./child.js";
import { createSpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["exit", "disconnect", "requested disconnect"] as const)(
  "joins IPC and process exit when %s arrives first",
  async (first) => {
    const child = new BrokerChild(1, ["fixture"], async () => {});
    const events: string[] = [];
    for (const event of ["exit", "disconnect", "close"]) {
      child.on(event, () => events.push(event));
    }
    const spawned = once(child, "spawn");
    child.receive({
      type: "spawned",
      id: 1,
      pid: 123,
      spawnfile: "fixture",
      spawnargs: ["fixture"],
      connected: true,
      stdioLength: 4,
    });
    await spawned;
    await setImmediate();
    if (first === "requested disconnect") {
      child.disconnect();
      expect(child.connected).toBe(false);
    }
    const exit = { type: "exit", id: 1, code: null, signal: "SIGKILL" } as const;
    const disconnect = { type: "disconnect", id: 1 } as const;
    const exitFirst = first !== "disconnect";
    child.receive(exitFirst ? exit : disconnect);
    expect(events).toEqual([exitFirst ? "exit" : "disconnect"]);
    child.receive(exitFirst ? disconnect : exit);
    await child.waitForClose();
    expect(events).toEqual(
      exitFirst ? ["exit", "disconnect", "close"] : ["disconnect", "exit", "close"],
    );
    expect(child).toMatchObject({ connected: false, signalCode: "SIGKILL" });
  },
);

it.skipIf(process.platform === "win32")("orders IPC during backpressure", async ({ signal }) => {
  const preload = path.join(tempDirs.make("openclaw-broker-event-order-"), "backpressure.mjs");
  await writeFile(
    preload,
    brokerSpawnPreload(
      `if (args[1]?.[1]?.includes('openclaw-event-order')) {
            child.on('message', message => {
              if (message === 'B') { sawB = true; publishSpawned?.(); }
              if (message === 'C') { sawC = true; finishA?.(); }
            });
          }`,
      "let sawB = false, sawC = false, publishSpawned, finishA;",
      `const nativeSend = process.send.bind(process);
        process.send = (message, handle, options, callback) => {
          if (message.type === 'spawned' && !sawB) {
            publishSpawned = () => nativeSend(message, handle, options, callback);
            return true;
          }
          if (message.type === 'ipc' && message.message === 'A') {
            return nativeSend(message, handle, options, error => {
              if (error || sawC) callback(error);
              else finishA = () => { finishA = undefined; callback(null); };
            });
          }
          return nativeSend(message, handle, options, callback);
        };
    `,
    ),
  );
  const host = await startPreloadedBroker(preload);
  const child = host.spawn(
    process.execPath,
    [
      "-e",
      `// openclaw-event-order
          process.on('message', () => process.send('C', () => process.disconnect()));
          process.send('A'); process.send('B');
        `,
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const messages: unknown[] = [];
  let continueDelivery: Promise<void> | undefined;
  child.on("message", (message: unknown) => {
    messages.push(message);
    if (message === "A") {
      continueDelivery = new Promise<void>((resolve, reject) => {
        child.send("continue", (error) => (error ? reject(error) : resolve()));
      });
      void continueDelivery.catch(() => {});
    }
  });
  await child.ready();
  await withinTest(child.waitForClose(), signal);
  await continueDelivery;
  expect(messages).toEqual(["A", "B", "C"]);
  expect(child.exitCode).toBe(0);
});

it.skipIf(!supportsSpawnBrokerCommandTransport())(
  "cleans partial handoff on broker death",
  async ({ signal }) => {
    const wait = <T>(work: PromiseLike<T>) => withinTest(work, signal);
    const receipts = await openFixtureReceiptChannel();
    onTestFinished(() => receipts.close());
    const host = createSpawnBrokerHost();
    const marker = path.join(tempDirs.make("openclaw-broker-handoff-"), "pid");
    let pid: number | undefined = undefined;
    let stoppedBroker: number | undefined;
    let closeOutcome: Promise<unknown> | undefined = undefined;
    onTestFinished(async () => {
      [stoppedBroker, pid].forEach((candidate) => signalFixturePid(candidate));
      await (closeOutcome ?? host.close());
    });
    await wait(host.ready());
    const child = host.spawn(
      "/bin/sh",
      [
        "-c",
        'printf "%s" "$$" > "$1"; "$2" --input-type=module -e "$3"; exec sleep 30',
        "fixture",
        marker,
        process.execPath,
        `${fixtureReceiptClientSource(receipts.endpoint)}
sendReceipt(${JSON.stringify(marker)}, "ready");
fixtureReceiptSocket.ref();
fixtureReceiptSocket.end();`,
      ],
      { stdio: Array.from({ length: 32 }, () => "pipe" as const), detached: true },
    );
    const readiness = child.ready().catch((error: unknown) => error);
    const pipeReady = Promise.withResolvers<void>();
    const attachPipe = child.attachPipe.bind(child);
    const attached = vi.spyOn(child, "attachPipe").mockImplementation((fd, socket) => {
      attachPipe(fd, socket);
      if (fd === 0) {
        pipeReady.resolve();
      }
    });
    onTestFinished(() => attached.mockRestore());
    await wait(
      awaitGateBeforeSettlement(
        pipeReady.promise,
        readiness,
        "Broker settled before stdin attached",
      ),
    );
    attached.mockRestore();
    expect(child.stdin).not.toBeNull();
    stoppedBroker = host.pid;
    process.kill(stoppedBroker!, "SIGSTOP");
    const readPid = () =>
      readFile(marker, "utf8").then(
        (content) => Number(content) || undefined,
        (error: unknown) => {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          return undefined;
        },
      );
    // The shell records its PID before reporting on the independent receipt channel.
    await wait(
      Promise.race([
        receipts.waitFor(marker, "ready"),
        readiness.then(async () => {
          if (!(await readPid())) {
            throw new Error("Broker settled before shell PID was recorded");
          }
        }),
      ]),
    );
    pid = await readPid();
    expect(pid).toBeTypeOf("number");
    expect(child.pid).toBeUndefined();
    process.kill(stoppedBroker!, "SIGKILL");
    // Join before yielding so the intentional SIGKILL is observed during shutdown.
    closeOutcome = host.close().catch((error: unknown) => error);
    stoppedBroker = undefined;
    await expect(wait(readiness)).resolves.toMatchObject({
      code: "ERR_SPAWN_BROKER_UNAVAILABLE",
    });
    await expect(wait(closeOutcome)).resolves.toMatchObject({
      name: "AggregateError",
      errors: [
        {
          code: "ERR_SPAWN_BROKER_UNAVAILABLE",
          message: "Spawn broker shutdown failed",
          cause: { message: "exited with code=null signal=SIGKILL" },
        },
      ],
    });
    await wait(child.waitForClose());
    expect(child.stdin?.destroyed).toBe(true);
    expect(isPidDefinitelyDead(pid!)).toBe(true);
  },
  15_000,
);
