export const MEETING_BROWSER_RECOVERY_TIMEOUT_MESSAGE = "Meeting browser recovery timed out.";

export function remainingMeetingBrowserDeadlineMs(
  deadline: number | undefined,
): number | undefined {
  if (deadline === undefined) {
    return undefined;
  }
  const remainingMs = Math.floor(deadline - Date.now());
  if (remainingMs <= 0) {
    throw new Error(MEETING_BROWSER_RECOVERY_TIMEOUT_MESSAGE);
  }
  return remainingMs;
}

export function isMeetingBrowserDeadlinePast(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() > deadline;
}

export async function waitForMeetingBrowserDeadline<T>(
  operation: () => Promise<T>,
  deadline: number | undefined,
): Promise<T> {
  const remainingMs = remainingMeetingBrowserDeadlineMs(deadline);
  if (remainingMs === undefined) {
    return await operation();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(MEETING_BROWSER_RECOVERY_TIMEOUT_MESSAGE)),
      remainingMs,
    );
  });
  try {
    return await Promise.race([operation(), expired]);
  } finally {
    clearTimeout(timer);
  }
}
