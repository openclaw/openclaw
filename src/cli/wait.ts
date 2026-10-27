export function waitForever() {
  // A pending promise alone cannot keep Node alive; this interval owns the process lifetime.
  setInterval(() => {}, 1_000_000);
  return new Promise<void>(() => {
    /* never resolve */
  });
}
