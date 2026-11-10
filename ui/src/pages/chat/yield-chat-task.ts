// Firefox implements scheduler.yield, but these extra turns delay transcript readiness.
export const splitChatConstruction = !navigator.userAgent.includes("Firefox/");

/** Continue preparation in a task without a timer clamp or a frame wait. */
export function yieldChatTask(): Promise<void> {
  // SAFETY: scheduler.yield is optional in supported browsers.
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?(): Promise<void> } })
    .scheduler;
  return (
    scheduler?.yield?.() ??
    new Promise<void>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      // This fresh one-shot port has one owner; onmessage also starts delivery.
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      port1.onmessage = () => {
        port1.close();
        port2.close();
        resolve();
      };
      port2.postMessage(undefined);
    })
  );
}
