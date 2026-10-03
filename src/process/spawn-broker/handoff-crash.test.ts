import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { createSpawnBrokerHost } from "./host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker admission custody", () => {
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts.close();
  });

  it("cleans a command when the broker dies before its pipes are ready", async ({ signal }) => {
    const host = createSpawnBrokerHost();
    const marker = path.join(tempDirs.make("openclaw-broker-handoff-"), "pid");
    let pid: number | undefined;
    let stoppedBroker: number | undefined;
    try {
      await withinTest(host.ready(), signal);
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
        {
          stdio: Array.from({ length: 32 }, () => "pipe" as const),
          detached: true,
        },
      );
      const readiness = child.ready().catch((error: unknown) => error);
      const pipeReady = createDeferred();
      const attachPipe = child.attachPipe.bind(child);
      const attached = vi.spyOn(child, "attachPipe").mockImplementation((fd, socket) => {
        attachPipe(fd, socket);
        if (fd === 0) {
          pipeReady.resolve();
        }
      });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            pipeReady.promise,
            readiness,
            "Broker settled before stdin attached",
          ),
          signal,
        );
      } finally {
        attached.mockRestore();
      }
      expect(child.stdin).not.toBeNull();
      stoppedBroker = host.pid;
      process.kill(stoppedBroker!, "SIGSTOP");
      const readPid = async () => {
        const content = await readFile(marker, "utf8").catch((error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return "";
          }
          throw error;
        });
        return Number(content) || undefined;
      };
      // The shell records its PID before reporting on the independent receipt channel.
      await withinTest(
        Promise.race([
          receipts.waitFor(marker, "ready"),
          readiness.then(async () => {
            if (!(await readPid())) {
              throw new Error("Broker settled before shell PID was recorded");
            }
          }),
        ]),
        signal,
      );
      pid = await readPid();
      expect(pid).toBeTypeOf("number");
      expect(child.pid).toBeUndefined();
      process.kill(stoppedBroker!, "SIGKILL");
      stoppedBroker = undefined;
      await expect(withinTest(readiness, signal)).resolves.toMatchObject({
        code: "ERR_SPAWN_BROKER_UNAVAILABLE",
      });
      await withinTest(host.close(), signal);
      expect(isPidDefinitelyDead(pid!)).toBe(true);
    } finally {
      for (const candidate of [stoppedBroker, pid]) {
        if (candidate) {
          try {
            process.kill(candidate, "SIGKILL");
          } catch {}
        }
      }
      await host.close();
    }
  }, 15_000);
});
