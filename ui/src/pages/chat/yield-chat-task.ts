/** Continue preparation in a task without a timer clamp or a frame wait.
 * Fine-grained splits can keep fallback browsers in the same task: another
 * MessageChannel turn makes Firefox's prepared transcript visible later.
 */
export function yieldChatTask(nativeOnly = false): Promise<void> {
  // SAFETY: scheduler.yield is optional in supported browsers.
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?(): Promise<void> } })
    .scheduler;
  return (
    scheduler?.yield?.() ??
    (nativeOnly
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const { port1, port2 } = new MessageChannel();
          // This fresh one-shot port has one owner; onmessage also starts delivery.
          // eslint-disable-next-line unicorn/prefer-add-event-listener
          port1.onmessage = () => {
            port1.close();
            port2.close();
            resolve();
          };
          port2.postMessage(undefined);
        }))
  );
}
