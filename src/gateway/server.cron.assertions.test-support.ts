import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";

export function expectCronJobIdFromResponse(response: { ok?: unknown; payload?: unknown }) {
  expect(response.ok, JSON.stringify((response as { error?: unknown }).error ?? null)).toBe(true);
  const value = (response.payload as { id?: unknown } | null)?.id;
  const id = typeof value === "string" ? value : "";
  expect(id.length > 0).toBe(true);
  return id;
}

export function expectCronRows(
  response: { ok: boolean; payload?: unknown },
  key: "entries" | "jobs" = "entries",
) {
  expect(response.ok).toBe(true);
  const payload = response.payload;
  if (!isRecord(payload) || !Array.isArray(payload[key])) {
    throw new Error(`expected cron ${key}`);
  }
  return payload[key].map((row: unknown) => {
    if (!isRecord(row)) {
      throw new Error(`expected a cron ${key} row`);
    }
    return row;
  });
}
