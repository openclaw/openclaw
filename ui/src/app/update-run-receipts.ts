import { getSafeLocalStorage } from "../local-storage.ts";

// Only browser acknowledgments live here. Run identity, progress and outcomes
// always come from the Gateway ledger, including after a bundle reload.
const ACKNOWLEDGED_KEY = "openclaw:control-ui:update-acknowledged:v1";

export function createUpdateRunReceipts() {
  const storage = getSafeLocalStorage();
  const read = (): string[] | null => {
    try {
      const raw = storage?.getItem(ACKNOWLEDGED_KEY);
      if (raw === null || raw === undefined) {
        return [];
      }
      const saved: unknown = raw.length < 32_768 ? JSON.parse(raw) : null;
      return Array.isArray(saved) && saved.every((item): item is string => typeof item === "string")
        ? saved.slice(-32)
        : null;
    } catch {
      return null;
    }
  };
  const id = (gateway: string, profile: string | null, runId: string) =>
    JSON.stringify([gateway, profile, runId]);
  return {
    acknowledged: (gateway: string, profile: string | null, runId: string) =>
      (read() ?? []).includes(id(gateway, profile, runId)),
    acknowledge: (gateway: string, profile: string | null, runId: string) => {
      try {
        const previous = read();
        if (!storage || !previous) {
          return false;
        }
        const receipts = [...new Set([...previous, id(gateway, profile, runId)])].slice(-32);
        storage.setItem(ACKNOWLEDGED_KEY, JSON.stringify(receipts));
        return true;
      } catch {
        return false;
      }
    },
  };
}
