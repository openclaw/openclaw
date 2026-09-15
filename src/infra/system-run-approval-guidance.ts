/** Add recovery guidance only at a failed approval-preparation presentation boundary. */
export function formatSystemRunApprovalPreparationError(message: string): string {
  // The binding owner still compares the original diagnostic internally. Do not
  // change that value or add this pre-request hint to post-approval revalidation.
  if (
    message !== "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command"
  ) {
    return message;
  }
  return `${message}\nNo approval request was created for this attempt; this is not a user denial. For shell chains, retry one command at a time with absolute paths or an explicit working directory. For inline code, use a script file. Retry through the normal approval flow.`;
}
