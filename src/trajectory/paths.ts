export const TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;
export const TRAJECTORY_RUNTIME_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = 256 * 1024;
export const TRAJECTORY_RUNTIME_RETENTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
export const TRAJECTORY_RUNTIME_RETENTION_MAX_BYTES = 512 * 1024 * 1024;

export function safeTrajectorySessionFileName(sessionId: string): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return /[A-Za-z0-9]/u.test(safe) ? safe : "session";
}
