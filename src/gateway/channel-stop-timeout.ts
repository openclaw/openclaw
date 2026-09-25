export async function waitForChannelStopGracefully(
  task: Promise<unknown> | undefined,
  timeoutMs: number,
) {
  if (!task) {
    return true;
  }
  // Channel stop hooks can hang during provider disconnects. Bound the wait so
  // restart/reload can continue after aborting the runtime.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
