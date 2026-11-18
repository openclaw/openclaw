import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { signalFixturePid } from "./broker-fixture.test-support.js";
import { createSpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = !supportsSpawnBrokerCommandTransport();

it.skipIf(skipBrokerTests)(
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
