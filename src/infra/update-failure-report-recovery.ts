import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import type { UpdateFailureReportReceipt } from "./update-failure-report-receipt-store.js";

export type UpdateFailureReportRecovery =
  | { reservationId: string; status: "created"; url: string }
  | { fallbackUrl: string; reservationId: string; status: "fallback" }
  | { reservationId: string; status: "retryable" };

function updateFailureReportRecoveryMatchesReceipt(
  recovery: UpdateFailureReportRecovery,
  receipt: UpdateFailureReportReceipt | null,
): boolean {
  if (recovery.reservationId !== receipt?.reservationId || recovery.status !== receipt.status) {
    return false;
  }
  return recovery.status === "created"
    ? recovery.url === receipt.url
    : recovery.status === "fallback"
      ? recovery.fallbackUrl === receipt.fallbackUrl
      : true;
}

export function tryMatchUpdateFailureReportRecovery(
  recovery: UpdateFailureReportRecovery,
  readReceipt: () => UpdateFailureReportReceipt | null,
): boolean {
  try {
    return updateFailureReportRecoveryMatchesReceipt(recovery, readReceipt());
  } catch {
    return false;
  }
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function recoveryPath(savedReportPath: string): string {
  return `${savedReportPath}.result.json`;
}

async function syncRecoveryDirectory(savedReportPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const directory = await fs.open(path.dirname(savedReportPath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isSafeCreatedIssueUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      !parsed.username &&
      !parsed.password &&
      /^\/openclaw\/openclaw\/issues\/\d+$/u.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function isSafeFallbackIssueUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/openclaw/openclaw/issues/new"
    );
  } catch {
    return false;
  }
}

export async function readUpdateFailureReportRecovery(
  savedReportPath: string,
): Promise<UpdateFailureReportRecovery | null> {
  let raw: string;
  try {
    raw = await fs.readFile(recoveryPath(savedReportPath), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!isPlainRecord(value) || typeof value.reservationId !== "string") {
    throw new Error("Saved update report recovery is invalid.");
  }
  if (value.status === "created" && isSafeCreatedIssueUrl(value.url)) {
    await syncRecoveryDirectory(savedReportPath);
    return { reservationId: value.reservationId, status: "created", url: value.url };
  }
  if (value.status === "fallback" && isSafeFallbackIssueUrl(value.fallbackUrl)) {
    await syncRecoveryDirectory(savedReportPath);
    return {
      fallbackUrl: value.fallbackUrl,
      reservationId: value.reservationId,
      status: "fallback",
    };
  }
  if (value.status === "retryable") {
    await syncRecoveryDirectory(savedReportPath);
    return { reservationId: value.reservationId, status: "retryable" };
  }
  throw new Error("Saved update report recovery is invalid.");
}

export async function writeUpdateFailureReportRecovery(
  savedReportPath: string,
  recovery: UpdateFailureReportRecovery,
): Promise<boolean> {
  const resultPath = recoveryPath(savedReportPath);
  const temporaryPath = `${resultPath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(recovery), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(temporaryPath, resultPath);
    await syncRecoveryDirectory(savedReportPath);
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    return true;
  } catch {
    const existing = await readUpdateFailureReportRecovery(savedReportPath).catch(() => null);
    if (updateFailureReportRecoveryMatchesReceipt(recovery, existing)) {
      return true;
    }
    return false;
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function discardUpdateFailureReportRecoveryBestEffort(
  savedReportPath: string,
): Promise<void> {
  await fs.rm(recoveryPath(savedReportPath), { force: true }).catch(() => {});
}
