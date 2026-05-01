import fs from "node:fs";

export type DetachedUpdateRecordedResult = {
  ok: boolean;
  reason?: string;
  exitCode?: number;
  afterVersion?: string | null;
  detail?: string;
};

function isDetachedUpdateRecordedResult(value: unknown): value is DetachedUpdateRecordedResult {
  return Boolean(
    value && typeof value === "object" && typeof (value as { ok?: unknown }).ok === "boolean",
  );
}

export function readDetachedUpdateResult(resultPath: string): DetachedUpdateRecordedResult | null {
  try {
    const raw = fs.readFileSync(resultPath, "utf8").trim();
    const parsed = JSON.parse(raw) as unknown;
    return isDetachedUpdateRecordedResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function removeDetachedUpdateResult(resultPath: string): void {
  try {
    fs.unlinkSync(resultPath);
  } catch {
    // best-effort
  }
}
