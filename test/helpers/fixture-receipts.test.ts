import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  openFixtureReleaseFifo,
} from "./fixture-receipts.js";
import { withinTest } from "./promise.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function nodeChild(endpoint: string, source: string) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", fixtureReceiptClientSource(endpoint) + "\n" + source],
    { stdio: "ignore" },
  );
  const closed = once(child, "close");
  return {
    child,
    closed,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    },
  };
}

describe("fixture receipts", () => {
  it.for(["normal", "SIGKILL"])("observes %s exit and retains it", async (mode, { signal }) => {
    const receipts = await withinTest(openFixtureReceiptChannel(), signal);
    const fixture = nodeChild(
      receipts.endpoint,
      mode === "normal"
        ? 'announce("child");'
        : 'sendReceipt("child", "ready"); await awaitRelease("child", "hold");',
    );
    try {
      const exited = receipts.waitForExit("child");
      if (mode === "SIGKILL") {
        await withinTest(receipts.waitFor("child", "ready"), signal);
        expect(fixture.child.kill("SIGKILL")).toBe(true);
      }
      await withinTest(exited, signal);
      const [code, exitSignal] = await withinTest(fixture.closed, signal);
      expect([code, exitSignal]).toEqual(mode === "normal" ? [0, null] : [null, "SIGKILL"]);
      await withinTest(receipts.waitForExit("child"), signal);
    } finally {
      await receipts.close();
      await fixture.close();
    }
  });

  it.for(["before", "after"])("delivers release %s a child waits", async (ordering, { signal }) => {
    const receipts = await withinTest(openFixtureReceiptChannel(), signal);
    if (ordering === "before") {
      receipts.release("child", "first");
      receipts.release("child", "second");
    }
    const fixture = nodeChild(
      receipts.endpoint,
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
    try {
      await withinTest(receipts.waitFor("child", "ready"), signal);
      if (ordering === "after") {
        expect(fixture.child.exitCode).toBeNull();
        expect(fixture.child.signalCode).toBeNull();
        receipts.release("child", "first");
        await withinTest(receipts.waitFor("child", "first released"), signal);
        expect(fixture.child.exitCode).toBeNull();
        receipts.release("child", "second");
      }
      await withinTest(receipts.waitFor("child", "released"), signal);
      await withinTest(receipts.waitForExit("child"), signal);
      const [code, exitSignal] = await withinTest(fixture.closed, signal);
      expect([code, exitSignal]).toEqual([0, null]);
    } finally {
      await receipts.close();
      await fixture.close();
    }
  });

  it("waits for every associated connection and releases later associations", async ({
    signal,
  }) => {
    const receipts = await withinTest(openFixtureReceiptChannel(), signal);
    const first = nodeChild(receipts.endpoint, 'await awaitRelease("shared", "first");');
    const second = nodeChild(
      receipts.endpoint,
      'sendReceipt("shared", "ready"); await awaitRelease("shared", "checkpoint"); sendReceipt("shared", "held"); await awaitRelease("shared", "second");',
    );
    try {
      receipts.release("shared", "first");
      await withinTest(receipts.waitFor("shared", "ready"), signal);
      await withinTest(first.closed, signal);
      let exited = false;
      const allExited = receipts.waitForExit("shared").then(() => {
        exited = true;
      });
      // A receipt round trip lets an erroneous early exit resolution become observable.
      receipts.release("shared", "checkpoint");
      await withinTest(receipts.waitFor("shared", "held"), signal);
      expect(exited).toBe(false);
      receipts.release("shared", "second");
      await withinTest(allExited, signal);
      await withinTest(second.closed, signal);
    } finally {
      await receipts.close();
      await first.close();
      await second.close();
    }
  });

  it("rejects pending exit observation when closed", async ({ signal }) => {
    const receipts = await withinTest(openFixtureReceiptChannel(), signal);
    const rejected = expect(receipts.waitForExit("missing")).rejects.toThrow(
      "closed while waiting for exit in missing",
    );
    try {
      await withinTest(receipts.close(), signal);
      await withinTest(rejected, signal);
    } finally {
      await receipts.close();
    }
  });

  it("rejects malformed messages for receipt and exit waiters", async ({ signal }) => {
    const receipts = await withinTest(openFixtureReceiptChannel(), signal);
    const receiptRejected = expect(receipts.waitFor("child", "ready")).rejects.toThrow(
      "Malformed fixture receipt",
    );
    const exitRejected = expect(receipts.waitForExit("child")).rejects.toThrow(
      "Malformed fixture receipt",
    );
    const fixture = nodeChild(
      receipts.endpoint,
      'connectReceipts().write(JSON.stringify({ announce: 42 }) + "\\n");',
    );
    try {
      await withinTest(Promise.all([receiptRejected, exitRejected]), signal);
    } finally {
      await receipts.close();
      await fixture.close();
    }
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
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      try {
        const [code] = await withinTest(closed, signal);
        expect(code).toBe(0);
        expect(stdout).toBe("released\n");
      } finally {
        child.kill("SIGKILL");
        await closed;
        await fifo.close();
      }
    },
  );
});
