import { afterEach, beforeEach, vi } from "vitest";

type MeetingTestRuntime = {
  list(): { id: string }[];
  leave(sessionId: string): Promise<unknown>;
};
type MeetingCleanupOptions = { readWarnings?: () => ReadonlyArray<readonly unknown[]> };

export function useMeetingTestState(
  createState: (options: { label: string }) => Promise<{ cleanup(): Promise<void> }>,
) {
  const cleanups: Array<() => Promise<void>> = [];
  let state: Awaited<ReturnType<typeof createState>> | undefined;
  let producerFailure: AggregateError | undefined;
  const onCleanup = (cleanup: () => Promise<void>, options: MeetingCleanupOptions = {}) => {
    const initialWarnings = options.readWarnings?.();
    const warningCount = initialWarnings?.length ?? 0;
    cleanups.push(async () => {
      await cleanup();
      const warnings = options.readWarnings?.();
      const failure = warnings
        ?.slice(warnings === initialWarnings ? warningCount : 0)
        .flat()
        .find(
          (value): value is string =>
            typeof value === "string" &&
            (value.includes("could not finalize durable capture") ||
              value.includes("durable transcript finalization queued for retry")),
        );
      if (failure) {
        throw new Error(failure);
      }
    });
  };

  beforeEach(async () => {
    if (state) {
      throw new Error("Previous meeting fixture cleanup did not complete");
    }
    state = await createState({ label: "meeting" });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (producerFailure) {
      throw producerFailure;
    }
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      producerFailure = new AggregateError(
        errors,
        "Meeting fixture producers did not finish cleanup",
      );
      throw producerFailure;
    }
    await state?.cleanup();
    state = undefined;
  });

  return {
    track<T extends MeetingTestRuntime>(runtime: T, options?: MeetingCleanupOptions): T {
      onCleanup(async () => {
        const errors: unknown[] = [];
        for (const session of runtime.list()) {
          try {
            await runtime.leave(session.id);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Meeting runtime sessions did not finish cleanup");
        }
      }, options);
      return runtime;
    },
    onCleanup,
  };
}
