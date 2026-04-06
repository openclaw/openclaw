type ApproverInput = string | number;

type ApprovalApproverParams = {
  explicit?: readonly ApproverInput[] | null;
  allowFrom?: readonly ApproverInput[] | null;
  extraAllowFrom?: readonly ApproverInput[] | null;
  defaultTo?: string | null;
  normalizeApprover: (value: ApproverInput) => string | undefined;
  normalizeDefaultTo?: (value: string) => string | undefined;
};

export type ApprovalApproverResolutionSource = "explicit" | "inferred" | "none";

export type ApprovalApproverResolution = {
  explicit: string[];
  inferred: string[];
  effective: string[];
  source: ApprovalApproverResolutionSource;
};

function dedupeDefined(values: Array<string | undefined>): string[] {
  const resolved = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    resolved.add(value);
  }
  return [...resolved];
}

function resolveExplicitApprovers(params: ApprovalApproverParams): string[] {
  return dedupeDefined((params.explicit ?? []).map((entry) => params.normalizeApprover(entry)));
}

function resolveInferredApprovers(params: ApprovalApproverParams): string[] {
  return dedupeDefined([
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
}

export function resolveApprovalApproverResolution(
  params: ApprovalApproverParams,
): ApprovalApproverResolution {
  const explicit = resolveExplicitApprovers(params);
  const inferred = resolveInferredApprovers(params);
  if (explicit.length > 0) {
    return {
      explicit,
      inferred,
      effective: explicit,
      source: "explicit",
    };
  }
  if (inferred.length > 0) {
    return {
      explicit,
      inferred,
      effective: inferred,
      source: "inferred",
    };
  }
  return {
    explicit,
    inferred,
    effective: [],
    source: "none",
  };
}

export function resolveApprovalApprovers(params: ApprovalApproverParams): string[] {
  return resolveApprovalApproverResolution(params).effective;
}
