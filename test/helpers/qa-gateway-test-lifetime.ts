import type { TestContext } from "vitest";
import { createFixtureLifetime } from "./fixture-lifetime.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

type QaGatewayTestLifetime = {
  signal: AbortSignal;
  verifyCleanup: (cleanup: () => Promise<void>) => Promise<void>;
  createTempDir: (prefix: string) => string;
};

/** Retain the original fixture and its cleanup after Vitest cancels its test wrapper. */
export function runQaGatewayTestFixture<T>(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  body: (lifetime: QaGatewayTestLifetime) => Promise<T>,
  ...cleanups: Array<() => unknown>
): Promise<T> {
  const fixture = createFixtureLifetime();
  context.onTestFinished(() => fixture.cleanup());
  const lifetime = {
    signal: context.signal,
    verifyCleanup: fixture.verifyCleanup,
    createTempDir: (prefix: string) => fixture.createTempDir(prefix),
  };
  return fixture.run(() =>
    runQaGatewayFixture(
      async () => {
        context.signal.throwIfAborted();
        return await body(lifetime);
      },
      ...cleanups.map(
        (cleanup) => () =>
          fixture.verifyCleanup(async () => {
            await cleanup();
          }),
      ),
    ),
  );
}
