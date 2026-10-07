/** Routing callbacks and generic chat forwards can reach non-approvers. */
export function omitApprovalRequestMessage<T extends { request?: object | null }>(event: T): T {
  const request = event.request;
  const source = request && "approvalSource" in request ? request.approvalSource : undefined;
  if (!source || typeof source !== "object" || !("userMessageExcerpt" in source)) {
    return event;
  }
  const approvalSource = { ...source };
  delete approvalSource.userMessageExcerpt;
  return { ...event, request: { ...request, approvalSource } };
}
