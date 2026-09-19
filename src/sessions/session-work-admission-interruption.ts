/** Only the live run owner can confirm that this interruption accepted a stop. */
type SessionWorkAdmissionInterruptionReceipt = { runId: string };
export type SessionWorkAdmissionInterrupt = (
  reason?: Error,
) => SessionWorkAdmissionInterruptionReceipt | void;

export async function waitForSessionWorkAdmissionRelease(
  released: Promise<void>,
  timeoutMs?: number,
): Promise<boolean> {
  if (timeoutMs === undefined) {
    await released;
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      released.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
