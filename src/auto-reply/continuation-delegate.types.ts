export interface PendingContinuationDelegate {
  task: string;
  delayMs?: number;
  silent?: boolean;
  silentWake?: boolean;
}

export interface DelayedContinuationReservation {
  id: string;
  source: "bracket" | "tool";
  task: string;
  createdAt: number;
  fireAt: number;
  plannedHop: number;
  silent?: boolean;
  silentWake?: boolean;
}
