import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { afterEach, expect, it, type TestContext } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  openFixtureReleaseFifo,
} from "./fixture-receipts.js";
import { withinTest } from "./promise.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function setup(context: TestContext) {
  const wait = <T>(promise: Promise<T>) => withinTest(promise, context.signal);
  const receipts = await wait(openFixtureReceiptChannel());
  const cleanups: Array<() => Promise<void>> = [];
  context.onTestFinished(async () => {
    await receipts.close();
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });
  return {
    ...receipts,
    wait,
    start(source: string) {
      const script = fixtureReceiptClientSource(receipts.endpoint) + "\n" + source;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: "ignore",
      });
      const closed = once(child, "close");
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await closed;
      });
      return { child, closed };
    },
  };
}

it("observes killed child exit and retains it", async (context) => {
  const { wait, ...receipts } = await setup(context);
  const fixture = receipts.start(
    'sendReceipt("child", "ready"); await awaitRelease("child", "hold");',
  );
  const exited = receipts.waitForExit("child");
  await wait(receipts.waitFor("child", "ready"));
  expect(fixture.child.kill("SIGKILL")).toBe(true);
  await wait(exited);
  expect(await wait(fixture.closed)).toEqual([null, "SIGKILL"]);
  await wait(receipts.waitForExit("child"));
});

it.for(["before", "after"])("delivers release %s a child waits", async (ordering, context) => {
  const { wait, ...receipts } = await setup(context);
  if (ordering === "before") {
    receipts.release("child", "first");
    receipts.release("child", "second");
  }
  const fixture = receipts.start(
    `
      sendReceipt("child", "ready");
      ${
        ordering === "before"
          ? `
      await awaitRelease("child", "second");
      await awaitRelease("child", "first");`
          : `
      const first = awaitRelease("child", "first");
      const second = awaitRelease("child", "second");
      await first;
      sendReceipt("child", "first released");
      await second;`
      }
      sendReceipt("child", "released");
    `,
  );
  await wait(receipts.waitFor("child", "ready"));
  if (ordering === "after") {
    receipts.release("child", "first");
    await wait(receipts.waitFor("child", "first released"));
    expect(fixture.child.exitCode).toBeNull();
    receipts.release("child", "second");
  }
  await wait(receipts.waitFor("child", "released"));
  await wait(receipts.waitForExit("child"));
  expect(await wait(fixture.closed)).toEqual([0, null]);
  await wait(receipts.waitForExit("child"));
});

it("waits for every associated connection and releases later associations", async (context) => {
  const { wait, ...receipts } = await setup(context);
  const first = receipts.start('await awaitRelease("shared", "first");');
  const second = receipts.start(
    'sendReceipt("shared", "ready"); await awaitRelease("shared", "checkpoint"); sendReceipt("shared", "held"); await awaitRelease("shared", "second");',
  );
  receipts.release("shared", "first");
  await wait(receipts.waitFor("shared", "ready"));
  await wait(first.closed);
  let exited = false;
  const allExited = receipts.waitForExit("shared").then(() => {
    exited = true;
  });
  // A receipt round trip lets an erroneous early exit resolution become observable.
  receipts.release("shared", "checkpoint");
  await wait(receipts.waitFor("shared", "held"));
  expect(exited).toBe(false);
  receipts.release("shared", "second");
  await wait(allExited);
  await wait(second.closed);
});

it.for(["closed", "malformed"])("rejects pending waiters when %s", async (failure, context) => {
  const { wait, ...receipts } = await setup(context);
  const malformed = failure === "malformed";
  const receiptRejected = malformed
    ? expect(receipts.waitFor("child", "ready")).rejects.toThrow("Malformed fixture receipt")
    : undefined;
  const exitRejected = expect(
    receipts.waitForExit(malformed ? "child" : "missing"),
  ).rejects.toThrow(
    malformed ? "Malformed fixture receipt" : "closed while waiting for exit in missing",
  );
  if (malformed) {
    receipts.start('connectReceipts().write(JSON.stringify({ announce: 42 }) + "\\n");');
  }
  if (!malformed) {
    await wait(receipts.close());
  }
  await wait(Promise.all([receiptRejected, exitRejected]));
});

it.skipIf(process.platform === "win32")(
  "releases a shell reader from a FIFO",
  async ({ signal }) => {
    const fifo = await withinTest(
      openFixtureReleaseFifo(tempDirs.make("fixture-release-"), "release"),
      signal,
    );
    // Buffered release must survive until a later reader opens the FIFO.
    await withinTest(fifo.release(), signal);
    const child = spawn("sh", ["-c", 'read -r _ < "$FIFO"; echo released'], {
      env: { ...process.env, FIFO: fifo.path },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const closed = once(child, "close");
    const output = text(child.stdout);
    try {
      const [[code], stdout] = await withinTest(Promise.all([closed, output]), signal);
      expect({ code, stdout }).toEqual({ code: 0, stdout: "released\n" });
    } finally {
      child.kill("SIGKILL");
      await closed;
      await fifo.close();
    }
  },
);
