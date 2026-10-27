import { expect, it, vi } from "vitest";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";

for (const timing of ["already aborted", "queued"] as const) {
  it.each([
    { kind: "Error", reason: new Error("read cancelled") },
    { kind: "string", reason: "read cancelled" },
    { kind: "object", reason: { detail: "read cancelled" } },
  ])(`retains the ${timing} $kind reason while settling accepted work`, async ({ reason }) => {
    const controller = new AbortController();
    const blocker = Promise.withResolvers<void>();
    const operation = vi.fn(async () => "unexpected read");
    let cancelled: Promise<unknown> | undefined;
    let settled = false;
    if (timing === "already aborted") {
      controller.abort(reason);
    }
    const settlement = withTranscriptLockSettlement((queue) => {
      void queue(() => blocker.promise);
      cancelled = queue(operation, controller.signal);
    }).then(() => {
      settled = true;
    });
    try {
      if (!cancelled) {
        throw new Error("The callback must queue its read synchronously");
      }
      const rejected = cancelled.catch((failure: unknown) => failure);
      if (timing === "queued") {
        controller.abort(reason);
      }
      const error = await rejected;
      expect(error).toBeInstanceOf(Error);
      if (reason instanceof Error) {
        expect(error).toBe(reason);
      } else if (error instanceof Error) {
        expect(error.name).toBe("AbortError");
        expect(error.cause).toBe(reason);
        if (typeof reason === "string") {
          expect(error).toHaveProperty("message", reason);
        }
      }
      expect(operation).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally {
      blocker.resolve();
      await settlement;
    }
    expect(operation).not.toHaveBeenCalled();
  });
}
