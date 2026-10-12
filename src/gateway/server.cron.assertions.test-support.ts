import { expect } from "vitest";

export function expectCronJobIdFromResponse(response: { ok?: unknown; payload?: unknown }) {
  expect(response.ok, JSON.stringify((response as { error?: unknown }).error ?? null)).toBe(true);
  const value = (response.payload as { id?: unknown } | null)?.id;
  const id = typeof value === "string" ? value : "";
  expect(id.length > 0).toBe(true);
  return id;
}

export function expectEnqueuedRunPayload(payload: unknown): string {
  const record = payload as { ok?: unknown; enqueued?: unknown; runId?: unknown } | null;
  expect(record?.ok).toBe(true);
  expect(record?.enqueued).toBe(true);
  expect(typeof record?.runId).toBe("string");
  return record?.runId as string;
}
