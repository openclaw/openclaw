import { consumeSelectedSystemEventEntries, enqueueSystemEventEntry } from "./system-events.js";

type SystemEventOptions = Parameters<typeof enqueueSystemEventEntry>[1];
export type SystemEventReceipt = Readonly<{ remove: () => boolean }>;

export function enqueueSystemEventWithReceipt(
  text: string,
  options: SystemEventOptions,
): SystemEventReceipt | null {
  const event = enqueueSystemEventEntry(text, options);
  if (!event) {
    return null;
  }
  const sessionKey = options.sessionKey.trim();
  let pending = true;
  return {
    remove: () => {
      if (!pending) {
        return false;
      }
      pending = false;
      return consumeSelectedSystemEventEntries(sessionKey, [event]).length === 1;
    },
  };
}
