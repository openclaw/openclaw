// A removed launch directory makes Node's process.cwd() throw before callers can recover.
// Keep the absence explicit so each trust boundary chooses whether to skip, fail, or fall back.
export function tryProcessCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}
