import { expect, it } from "vitest";
import {
  isCommandCancellation,
  runCancelableCommand,
} from "../../scripts/lib/cancelable-command.mts";
import { createDeferred } from "../helpers/promise.js";

it.for(
  (["SIGINT", "SIGTERM", "SIGHUP"] as const).flatMap((signal, index) =>
    (["joined", "abort", "release failure", "unjoined"] as const).map((outcome) => ({
      signal,
      exitCode: [130, 143, 129][index],
      outcome,
    })),
  ),
)("owns $signal through $outcome cleanup", async ({ signal, exitCode, outcome }) => {
  const previous = process.listeners(signal);
  const release = createDeferred<void>();
  const failure = Object.assign(
    new Error("cleanup failed", {
      cause: outcome === "unjoined" ? { processTreeState: "indeterminate" } : undefined,
    }),
    { code: outcome === "unjoined" ? "ABORT_ERR" : "EIO" },
  );
  let aborted = false;
  let settled = false;
  const command = runCancelableCommand(async (abortSignal) => {
    abortSignal.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    await release.promise;
    if (outcome === "abort") abortSignal.throwIfAborted();
    if (outcome === "release failure" || outcome === "unjoined") throw failure;
    return 7;
  });
  const result = command
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    // Invoke only this operation's listener; never signal the shared test process.
    const handler = process.listeners(signal).find((entry) => !previous.includes(entry))!;
    handler(signal);
    // The leaf sees the original signal before generic abort; ownership stays
    // pending for arbitrary asynchronous cleanup, without a second grace timer.
    expect(aborted).toBe(false);
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(settled).toBe(false);
    expect(process.listeners(signal)).toContain(handler);
    release.resolve();
    expect(await result).toEqual(
      outcome === "release failure" || outcome === "unjoined"
        ? { error: failure }
        : { value: exitCode },
    );
    expect(process.listeners(signal)).toEqual(previous);
  } finally {
    release.resolve();
    await result;
  }
});

it("preserves an ordinary result and an unsolicited cancellation error", async () => {
  expect(await runCancelableCommand(async () => 7)).toBe(7);
  const failure = Object.assign(new Error("external cancellation"), { code: "ABORT_ERR" });
  await expect(
    runCancelableCommand(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});

it("does not turn nested uncertain cleanup into successful cancellation", () => {
  const failure = Object.assign(new Error("cancelled"), {
    code: "ABORT_ERR",
    errors: [new Error("cleanup", { cause: { processTreeState: "live" } })],
  });
  expect(isCommandCancellation(failure)).toBe(false);
  expect(isCommandCancellation(new DOMException("cancelled", "AbortError"))).toBe(true);
});
