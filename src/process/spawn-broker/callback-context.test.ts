import { describe, expect, it } from "vitest";
import { runExec } from "../exec.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost } from "./host.js";

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("broker callback context", () => {
  it("keeps commands launched by process and pipe callbacks in the Gateway transport scope", async () => {
    const host = createSpawnBrokerHost();
    await host.ready();
    try {
      const parents = await runWithSpawnBroker(host, async () => {
        const child = host.spawn(
          process.execPath,
          ["-e", "process.on('message',()=>{process.stdout.write('output');process.disconnect()})"],
          {
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        await child.ready();
        const launch = async () =>
          Number(
            (
              await runExec(
                process.execPath,
                ["-e", "process.stdout.write(String(process.ppid))"],
                { logOutput: false },
              )
            ).stdout,
          );
        const fromOutput = new Promise<number>((resolve, reject) => {
          child.stdout!.once("data", () => {
            void launch().then(resolve, reject);
          });
        });
        const fromExit = new Promise<number>((resolve, reject) => {
          child.once("exit", () => {
            void launch().then(resolve, reject);
          });
        });
        const fromSend = new Promise<number>((resolve, reject) => {
          child.send("start", (error) => {
            if (error) {
              reject(error);
            } else {
              void launch().then(resolve, reject);
            }
          });
        });
        child.stderr!.resume();
        await child.waitForClose();
        return await Promise.all([fromOutput, fromExit, fromSend]);
      });
      expect(parents).toEqual([host.pid, host.pid, host.pid]);
    } finally {
      await host.close();
    }
  });
});
