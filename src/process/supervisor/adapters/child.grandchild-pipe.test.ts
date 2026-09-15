// Real-process coverage for #147304: a session whose script backgrounds a
// pipeline inheriting the session's stdio must settle shortly after the root
// command exits, instead of waiting on the output pipe held by the detached
// grandchild. Unlike child.test.ts, this file does not mock spawnWithFallback —
// it exercises the real spawn path end to end.

import { describe, expect, it } from "vitest";
import { createChildAdapter } from "./child.js";

describe("createChildAdapter (real process)", () => {
  it.skipIf(process.platform === "win32")(
    "settles a real session whose detached grandchild holds the output pipe",
    async () => {
      const adapter = await createChildAdapter({
        argv: ["bash", "-c", "nohup sleep 30 | cat &"],
        stdinMode: "pipe-open",
      });

      const result = await Promise.race([
        adapter.wait().then((value) => ({ settled: true as const, value })),
        new Promise<{ settled: false }>((resolve) => {
          const timer = setTimeout(() => resolve({ settled: false }), 5_000);
          timer.unref?.();
        }),
      ]);

      // The root `bash -c` exits immediately; only the detached grandchild
      // (`sleep 30 | cat`) still holds the pipe, and the session must not
      // wait for it (#147304).
      if (!result.settled) {
        throw new Error("session must settle within 5s despite the detached grandchild");
      }
      expect(result.value.code).toBe(0);

      // The detached grandchild outlives the run and exits on its own.
    },
    10_000,
  );
});
