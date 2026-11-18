// Keep the original native error and errno. A failed outer compensation replaces
// the error, so it must not inherit this proof from a nested cause or message.
const notActivated = new WeakSet<Error>();

export function markLaunchAgentNotActivated(error: Error): Error {
  notActivated.add(error);
  return error;
}

export function isLaunchAgentNotActivated(error: unknown): boolean {
  return error instanceof Error && notActivated.has(error);
}
