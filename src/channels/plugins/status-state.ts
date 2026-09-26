/**
 * Human-readable channel status-state labels for status output.
 */
export function formatChannelStatusState(statusState: string): string {
  switch (statusState) {
    case "not-linked":
      return "not linked";
    case "unstable":
      return "auth stabilizing";
    default:
      return statusState;
  }
}
