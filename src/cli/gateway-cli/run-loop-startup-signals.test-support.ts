import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createCloseMock,
  createGatewayServer,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerGatewayStartupSignalTests(
  fixtures: Pick<UpdateRespawnFixtures, "acquireGatewayLock">,
): void {
  const { acquireGatewayLock } = fixtures;
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)(
    "releases initial custody when the CLI owner accepts %s before the loop owns signals",
    async (signal, code) => {
      const { waitForCliSignalExit, waitForSignalExitBarriers, withGatewayStartupSignalOwner } =
        await import("../signal-exit-barrier.js");
      const previousExitCode = process.exitCode;
      const releaseLock = vi.fn(async () => {});
      acquireGatewayLock.mockImplementationOnce(async () => {
        // The stop lands while startup acquires custody, before the loop's handlers exist.
        void waitForSignalExitBarriers(signal);
        return { release: releaseLock };
      });
      const start = vi.fn<Parameters<typeof import("./run-loop.js").runGatewayLoop>[0]["start"]>();
      try {
        await withIsolatedSignals(async () => {
          const { runGatewayLoop } = await import("./run-loop.js");
          await expect(
            withGatewayStartupSignalOwner(() => runGatewayLoop({ start })),
          ).rejects.toMatchObject({ name: "ExitError", code });
        });
        expect(releaseLock).toHaveBeenCalledOnce();
        expect(start).not.toHaveBeenCalled();
        await expect(waitForCliSignalExit()).resolves.toBe(code);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );

  it("hands SIGINT and SIGTERM to the run loop once its handlers are installed", async () => {
    const { withGatewayStartupSignalOwner } = await import("../signal-exit-barrier.js");
    const before = new Set([...process.listeners("SIGINT"), ...process.listeners("SIGTERM")]);
    const added = () =>
      [...process.listeners("SIGINT"), ...process.listeners("SIGTERM")].filter(
        (listener) => !before.has(listener),
      );
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { runGatewayLoop } = await import("./run-loop.js");
      const started = createDeferredCore();
      const start = vi.fn<Parameters<typeof runGatewayLoop>[0]["start"]>(async () => {
        started.resolve();
        return createGatewayServer(createCloseMock());
      });
      const loop = withGatewayStartupSignalOwner(() => runGatewayLoop({ start }));
      await started.promise;
      // The startup owner is gone, so a stop now runs only the loop's own shutdown.
      expect(added()).toHaveLength(2);
      captureSignal("SIGTERM")();
      await expect(loop).resolves.toBe(0);
    });
  });
}
