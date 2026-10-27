import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { brokerSpawnPreload, startPreloadedBroker } from "./broker-fixture.test-support.js";
import { BrokerChild } from "./child.js";

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
