import { uniqueStrings } from "../../packages/normalization-core/src/string-normalization.js";

type ApproverInput = string | number;

function dedupeDefined(values: Array<string | undefined>): string[] {
  return uniqueStrings(values.filter((value): value is string => Boolean(value)));
}

/** Resolves approval actors with explicit approvers taking precedence over inferred allowlists. */
export function resolveApprovalApprovers(params: {
  /** Explicit approver ids; when any normalize successfully, inferred sources are ignored. */
  explicit?: readonly ApproverInput[] | null;
  /** Primary inferred approver source, usually channel allowFrom config. */
  allowFrom?: readonly ApproverInput[] | null;
  /** Secondary inferred approver source merged after allowFrom. */
  extraAllowFrom?: readonly ApproverInput[] | null;
  /** Fallback single destination when no configured allowlist entries exist. */
  defaultTo?: string | null;
  /** Channel-specific normalization for configured approver ids. */
  normalizeApprover: (value: ApproverInput) => string | undefined;
  /** Optional destination-specific normalization for defaultTo. */
  normalizeDefaultTo?: (value: string) => string | undefined;
}): string[] {
  const explicit = dedupeDefined(
    (params.explicit ?? []).map((entry) => params.normalizeApprover(entry)),
  );
  if (explicit.length > 0) {
    return explicit;
  }

  const inferred = dedupeDefined([
    ...(params.allowFrom ?? []).map((entry) => params.normalizeApprover(entry)),
    ...(params.extraAllowFrom ?? []).map((entry) => params.normalizeApprover(entry)),
    ...(params.defaultTo?.trim()
      ? [
          (params.normalizeDefaultTo ?? ((value: string) => params.normalizeApprover(value)))(
            params.defaultTo.trim(),
          ),
        ]
      : []),
  ]);
  return inferred;
}
