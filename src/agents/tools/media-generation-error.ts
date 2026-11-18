/** Cleanup must not replace a generation failure, even when either rejection is undefined. */
export async function rethrowAfterMediaCleanup(
  error: unknown,
  cleanup: () => void | Promise<void>,
  message: string,
): Promise<never> {
  let failure = error;
  try {
    await cleanup();
  } catch (cleanupError) {
    failure = new AggregateError([error, cleanupError], message, { cause: error });
  }
  throw failure;
}
