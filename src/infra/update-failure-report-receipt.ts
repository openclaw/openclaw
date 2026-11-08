import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";

export type UpdateFailureReportReceipt = {
  artifactSweep?: "pending";
  cleanup?: "pending";
  fallbackUrl?: string;
  preparingSinceMs?: number;
  previewDigest?: string;
  replacementReady?: true;
  reservationId: string;
  status: "preparing" | "prepared" | "pending" | "retryable" | "created" | "fallback";
  sweepGeneration?: string;
  sweepOwnerId?: string;
  sweepSinceMs?: number;
  url?: string;
};

function isCanonicalGithubUrl(
  value: unknown,
  pathname: RegExp,
  allowSearch: boolean,
): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === "https://github.com" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      (allowSearch || !parsed.search) &&
      pathname.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function isPreviewDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function isValidTerminalReceipt(receipt: UpdateFailureReportReceipt): boolean {
  if (!isPreviewDigest(receipt.previewDigest) || receipt.preparingSinceMs !== undefined) {
    return false;
  }
  if (receipt.status === "created") {
    return (
      receipt.cleanup === "pending" &&
      receipt.fallbackUrl === undefined &&
      isCanonicalGithubUrl(receipt.url, /^\/openclaw\/openclaw\/issues\/\d+$/u, false)
    );
  }
  if (receipt.status === "fallback") {
    return (
      receipt.cleanup === undefined &&
      receipt.url === undefined &&
      isCanonicalGithubUrl(receipt.fallbackUrl, /^\/openclaw\/openclaw\/issues\/new$/u, true)
    );
  }
  return (
    receipt.status === "retryable" &&
    receipt.cleanup === undefined &&
    receipt.url === undefined &&
    receipt.fallbackUrl === undefined
  );
}

export function parseUpdateFailureReportReceipt(value: unknown): UpdateFailureReportReceipt | null {
  if (
    !isPlainRecord(value) ||
    (value.status !== "preparing" &&
      value.status !== "prepared" &&
      value.status !== "pending" &&
      value.status !== "retryable" &&
      value.status !== "created" &&
      value.status !== "fallback") ||
    typeof value.reservationId !== "string" ||
    ((value.status === "preparing" || value.status === "prepared") &&
      (typeof value.preparingSinceMs !== "number" || !Number.isFinite(value.preparingSinceMs))) ||
    (value.artifactSweep !== undefined && value.artifactSweep !== "pending") ||
    (value.cleanup !== undefined && value.cleanup !== "pending") ||
    (value.previewDigest !== undefined && !isPreviewDigest(value.previewDigest)) ||
    (value.replacementReady !== undefined && value.replacementReady !== true) ||
    (value.replacementReady === true &&
      (value.status !== "retryable" ||
        value.cleanup !== undefined ||
        value.artifactSweep !== "pending")) ||
    (value.sweepOwnerId === undefined) !== (value.sweepSinceMs === undefined) ||
    (value.sweepOwnerId === undefined) !== (value.sweepGeneration === undefined) ||
    (value.sweepGeneration !== undefined && typeof value.sweepGeneration !== "string") ||
    (value.sweepOwnerId !== undefined && typeof value.sweepOwnerId !== "string") ||
    (value.sweepSinceMs !== undefined &&
      (typeof value.sweepSinceMs !== "number" || !Number.isFinite(value.sweepSinceMs))) ||
    (value.sweepOwnerId !== undefined && value.artifactSweep !== "pending") ||
    (value.status === "created" &&
      !isCanonicalGithubUrl(value.url, /^\/openclaw\/openclaw\/issues\/\d+$/u, false)) ||
    (value.status === "fallback" &&
      !isCanonicalGithubUrl(value.fallbackUrl, /^\/openclaw\/openclaw\/issues\/new$/u, true)) ||
    (value.cleanup !== undefined && value.status !== "created" && value.status !== "retryable") ||
    (value.status !== "created" && value.url !== undefined) ||
    (value.status !== "fallback" && value.fallbackUrl !== undefined)
  ) {
    return null;
  }
  return {
    ...(value.artifactSweep === "pending" ? { artifactSweep: value.artifactSweep } : {}),
    reservationId: value.reservationId,
    status: value.status,
    ...(value.cleanup === "pending" ? { cleanup: value.cleanup } : {}),
    ...(typeof value.preparingSinceMs === "number"
      ? { preparingSinceMs: value.preparingSinceMs }
      : {}),
    ...(typeof value.previewDigest === "string" ? { previewDigest: value.previewDigest } : {}),
    ...(value.replacementReady === true ? { replacementReady: value.replacementReady } : {}),
    ...(typeof value.sweepGeneration === "string"
      ? { sweepGeneration: value.sweepGeneration }
      : {}),
    ...(typeof value.sweepOwnerId === "string" ? { sweepOwnerId: value.sweepOwnerId } : {}),
    ...(typeof value.sweepSinceMs === "number" ? { sweepSinceMs: value.sweepSinceMs } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.fallbackUrl === "string" ? { fallbackUrl: value.fallbackUrl } : {}),
  };
}

type UpdateFailureReportReservation = {
  receipt: UpdateFailureReportReceipt | null;
  reserved: boolean;
};

export function decodeUpdateFailureReportReservation(
  value: unknown,
): UpdateFailureReportReservation | undefined {
  if (!isPlainRecord(value) || typeof value.reserved !== "boolean") {
    return undefined;
  }
  const receipt = parseUpdateFailureReportReceipt(value.receipt);
  if ((value.receipt !== null && !receipt) || (value.reserved && receipt?.status !== "preparing")) {
    return undefined;
  }
  return { receipt, reserved: value.reserved };
}

export function decodeUpdateFailureReportMutation(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export async function confirmUpdateFailureReportReceipt(
  readReceipt: () => UpdateFailureReportReceipt | null | Promise<UpdateFailureReportReceipt | null>,
  expected: UpdateFailureReportReceipt,
): Promise<boolean> {
  try {
    const receipt = await readReceipt();
    return (
      receipt?.reservationId === expected.reservationId &&
      receipt.status === expected.status &&
      receipt.previewDigest === expected.previewDigest &&
      receipt.cleanup === expected.cleanup &&
      receipt.url === expected.url &&
      receipt.fallbackUrl === expected.fallbackUrl
    );
  } catch {
    return false;
  }
}
