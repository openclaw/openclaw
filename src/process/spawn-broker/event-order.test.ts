import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSpawnBrokerHost } from "./host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker event order", () => {
  it("keeps startup IPC ahead of messages arriving while its first write drains", async () => {
    const preload = path.join(tempDirs.make("openclaw-broker-event-order-"), "backpressure.mjs");
    await writeFile(
      preload,
      `
      import childProcess from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      if (/\\/spawn-broker\\/worker\\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
        let sawB = false, sawC = false, publishSpawned, finishA;
        const nativeSpawn = childProcess.spawn;
        childProcess.spawn = function(...args) {
          const child = nativeSpawn.apply(this,args);
          if (args[1]?.[1]?.includes('openclaw-event-order')) {
            child.on('message', message => {
              if (message === 'B') { sawB = true; publishSpawned?.(); }
              if (message === 'C') { sawC = true; finishA?.(); }
            });
          }
          return child;
        };
        syncBuiltinESMExports();
        const nativeSend = process.send.bind(process);
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
      }
    `,
    );
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${previousNodeOptions ?? ""} --import=${pathToFileURL(preload).href}`;
    const host = createSpawnBrokerHost();
    const restoreNodeOptions = () => {
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    };
    try {
      try {
        await host.ready();
      } finally {
        restoreNodeOptions();
      }
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
      await withTestTimeout(
        child.waitForClose(),
        5_000,
        "IPC backpressure handshake did not finish",
      );
      await continueDelivery;
      expect(messages).toEqual(["A", "B", "C"]);
      expect(child.exitCode).toBe(0);
    } finally {
      restoreNodeOptions();
      await host.close();
    }
  });
});
