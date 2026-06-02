type SystemRunApprovalGuardError = {
  ok: false;
  message: string;
  details: Record<string, unknown>;
};

/**
 * Build a stable `node.invoke` guard failure for rejected `system.run` approval
 * overrides. Callers inspect `details.code`, so new denial reasons should be
 * explicit instead of folding into the human message.
 */
export function systemRunApprovalGuardError(params: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): SystemRunApprovalGuardError {
  const details = params.details ? { ...params.details } : {};
  return {
    ok: false,
    message: params.message,
    details: {
      code: params.code,
      ...details,
    },
  };
}

/**
 * Return the canonical response for an approval id that exists but has not
 * produced a reusable decision for this forwarded call.
 */
export function systemRunApprovalRequired(runId: string): SystemRunApprovalGuardError {
  return systemRunApprovalGuardError({
    code: "APPROVAL_REQUIRED",
    message: "approval required",
    details: { runId },
  });
}
