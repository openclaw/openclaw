import { afterEach, vi } from "vitest";

// The canonical executor still owns real SQL, admission, and settlement; only reply delivery changes.
const delivery = vi.hoisted(() => ({
  afterResult: undefined as ((result: unknown) => void | Promise<void>) | undefined,
  releaseFailure: undefined as Error | undefined,
  afterRelease: undefined as (() => Promise<void>) | undefined,
}));

export function getReplacementPublicationDelivery() {
  return delivery;
}

vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  const { decorateSessionExecutionCaptures } =
    await import("./session-execution-delivery.test-support.js");
  return {
    ...actual,
    ...decorateSessionExecutionCaptures(
      actual,
      (scope) => ({
        execute: async (command, commandOptions) => {
          const result = await scope.execute(command, commandOptions);
          if (command.type === "session.entries.replace") {
            await delivery.afterResult?.(result);
          }
          return result;
        },
      }),
      async (owned) => {
        await owned.release();
        const afterRelease = delivery.afterRelease;
        delivery.afterRelease = undefined;
        await afterRelease?.();
        if (delivery.releaseFailure) {
          throw delivery.releaseFailure;
        }
      },
    ),
  };
});

afterEach(() => {
  delivery.afterResult = undefined;
  delivery.releaseFailure = undefined;
  delivery.afterRelease = undefined;
});
