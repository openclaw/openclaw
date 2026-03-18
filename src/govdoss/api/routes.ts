import { govdossUsageMeter } from "../usage-meter.js";
import { resumeGovdossRequest, approveGovdossRequest, rejectGovdossRequest } from "../approval-resume.js";
import type { GovdossApiPrincipal } from "./auth.js";

export async function handleExecuteRoute(input: {
  principal: GovdossApiPrincipal;
  method: string;
  params?: Record<string, unknown>;
}) {
  govdossUsageMeter.record({
    tenantId: input.principal.tenantId,
    planTier: "team",
    category: "request",
    method: input.method,
    units: 1,
  });

  return {
    status: "accepted",
    method: input.method,
  };
}

export function handleApproveRoute(input: {
  principal: GovdossApiPrincipal;
  approvalId: string;
}) {
  const result = approveGovdossRequest(input.approvalId);

  govdossUsageMeter.record({
    tenantId: input.principal.tenantId,
    planTier: "team",
    category: "approval",
    units: 1,
  });

  return result;
}

export function handleRejectRoute(input: {
  principal: GovdossApiPrincipal;
  approvalId: string;
}) {
  const result = rejectGovdossRequest(input.approvalId);
  return result;
}

export async function handleResumeRoute(input: {
  principal: GovdossApiPrincipal;
  approvalId: string;
}) {
  const result = resumeGovdossRequest(input.approvalId);

  govdossUsageMeter.record({
    tenantId: input.principal.tenantId,
    planTier: "team",
    category: "resume",
    units: 1,
  });

  return result;
}

export function handleUsageRoute(input: {
  principal: GovdossApiPrincipal;
}) {
  return govdossUsageMeter.summarizeTenant(input.principal.tenantId);
}
