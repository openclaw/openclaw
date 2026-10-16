import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { formatDateTimeMs } from "../format.ts";

type CustomSnooze = { snoozedUntil: number; selectedAt: number };
const lifetimeMs = 60 * 60 * 1000;
// Storage-denied browsers can still reuse a choice until this page is closed.
const volatileChoices = new Map<string, CustomSnooze>();

export function customSnoozeStorageKey(gatewayUrl: string, accountScope: string): string | null {
  return accountScope
    ? "openclaw.control.customSnooze.v1:" +
        JSON.stringify([gatewayCredentialScope(gatewayUrl), accountScope])
    : null;
}

function validChoice(value: unknown, now: number): value is CustomSnooze {
  if (
    !value ||
    typeof value !== "object" ||
    !("selectedAt" in value) ||
    !("snoozedUntil" in value)
  ) {
    return false;
  }
  return (
    typeof value.selectedAt === "number" &&
    Number.isFinite(value.selectedAt) &&
    value.selectedAt <= now &&
    now - value.selectedAt < lifetimeMs &&
    typeof value.snoozedUntil === "number" &&
    value.snoozedUntil > now &&
    Number.isFinite(new Date(value.snoozedUntil).getTime())
  );
}

export function readCustomSnooze(key: string | null, now = Date.now()): number | null {
  if (!key) {
    return null;
  }
  const volatile = volatileChoices.get(key);
  if (validChoice(volatile, now)) {
    return volatile.snoozedUntil;
  }
  let value: unknown;
  const storage = getSafeLocalStorage();
  try {
    value = storage ? JSON.parse(storage.getItem(key) ?? "null") : volatileChoices.get(key);
  } catch {
    value = volatileChoices.get(key);
  }
  if (validChoice(value, now)) {
    return value.snoozedUntil;
  }
  volatileChoices.delete(key);
  try {
    storage?.removeItem(key);
  } catch {
    /* Storage is optional. */
  }
  return null;
}

export function rememberCustomSnooze(
  key: string | null,
  snoozedUntil: number,
  now = Date.now(),
): void {
  if (!key) {
    return;
  }
  const choice = { snoozedUntil, selectedAt: now };
  if (!validChoice(choice, now)) {
    return;
  }
  for (const [scope, previous] of volatileChoices) {
    if (!validChoice(previous, now)) {
      volatileChoices.delete(scope);
    }
  }
  try {
    const storage = getSafeLocalStorage();
    if (storage) {
      storage.setItem(key, JSON.stringify(choice));
      volatileChoices.delete(key);
      return;
    }
  } catch {
    /* Keep the successful selection usable without persistent storage. */
  }
  volatileChoices.set(key, choice);
}

export function localSnoozeInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    "T" +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

export function parseCustomSnooze(value: string, now = Date.now()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) {
    return null;
  }
  const date = new Date(value);
  // Reject normalized invalid dates and nonexistent local times at the DST jump.
  return Number.isFinite(date.getTime()) &&
    date.getTime() > now &&
    localSnoozeInputValue(date) === value
    ? date.getTime()
    : null;
}

export function formatCustomSnooze(snoozedUntil: number): string {
  return formatDateTimeMs(snoozedUntil, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
