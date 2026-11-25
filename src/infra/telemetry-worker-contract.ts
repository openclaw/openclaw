export type TelemetryState = {
  lastPingAt?: number;
  latestVersion?: string;
  note?: string;
};

export type SuccessfulTelemetryState = TelemetryState & {
  lastPingAt: number;
  latestVersion: string;
};
