/** Report whether a synchronous assertion completes without throwing. */
export function assertionSucceeds(assertion: () => void): boolean {
  try {
    assertion();
    return true;
  } catch {
    return false;
  }
}
