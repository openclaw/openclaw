import { MeetingSessionJoinLock } from "./session-join-lock.js";

const browserActLock = new MeetingSessionJoinLock();
const BROWSER_ACT_TIMEOUT_MESSAGE =
  "Meeting browser operation timed out waiting for browser tab control.";

// Browser evaluate calls can await page APIs and interleave in one tab. Keep
// ownership, audio, caption, transcript, and leave mutations process-serialized.
export async function runMeetingBrowserAct<T>(params: {
  deadline: number;
  operation: (remainingMs: number) => Promise<T>;
  targetId: string;
}): Promise<T> {
  const waitMs = Math.floor(params.deadline - Date.now());
  if (waitMs <= 0) {
    throw new Error(BROWSER_ACT_TIMEOUT_MESSAGE);
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const queued = browserActLock.run(params.targetId, async () => {
    clearTimeout(timeout);
    const remainingMs = Math.floor(params.deadline - Date.now());
    if (remainingMs <= 0) {
      throw new Error(BROWSER_ACT_TIMEOUT_MESSAGE);
    }
    return await params.operation(remainingMs);
  });
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(BROWSER_ACT_TIMEOUT_MESSAGE));
    }, waitMs);
  });
  try {
    return await Promise.race([queued, expired]);
  } finally {
    clearTimeout(timeout);
  }
}
