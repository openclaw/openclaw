export type DispatchIdleWaiter = (() => Promise<void>) | undefined;

export async function runAfterDispatchIdle(waitForDispatchIdle: DispatchIdleWaiter): Promise<void> {
  await waitForDispatchIdle?.();
}

export async function runAndWaitForDispatchIdle(
  run: () => Promise<void>,
  waitForDispatchIdle: DispatchIdleWaiter,
): Promise<void> {
  await run();
  await waitForDispatchIdle?.();
}
