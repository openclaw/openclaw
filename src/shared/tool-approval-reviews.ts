import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export type ToolApprovalReview = {
  id: string;
  label: string;
  status: "in_progress" | "approved" | "denied" | "timed_out" | "aborted";
  riskLevel?: string;
  userAuthorization?: string;
  rationale?: string;
};

const REVIEW_STATUSES = new Set<string>([
  "in_progress",
  "approved",
  "denied",
  "timed_out",
  "aborted",
]);
export const MAX_TOOL_APPROVAL_REVIEWS = 16;

function boundedString(value: unknown, maxChars: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? truncateUtf16Safe(text, maxChars) : undefined;
}

function isReviewStatus(value: string | undefined): value is ToolApprovalReview["status"] {
  return value !== undefined && REVIEW_STATUSES.has(value);
}

export function normalizeToolApprovalReview(value: unknown): ToolApprovalReview | null {
  const review = asNullableRecord(value);
  const id = boundedString(review?.id, 256);
  const label = boundedString(review?.label, 80);
  const status = boundedString(review?.status, 32);
  if (!id || !label || !isReviewStatus(status)) {
    return null;
  }
  const riskLevel = boundedString(review?.riskLevel, 40);
  const userAuthorization = boundedString(review?.userAuthorization, 40);
  const rationale = boundedString(review?.rationale, 2_000);
  return {
    id,
    label,
    status,
    ...(riskLevel ? { riskLevel } : {}),
    ...(userAuthorization ? { userAuthorization } : {}),
    ...(rationale ? { rationale } : {}),
  };
}
