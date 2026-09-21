export type TelemetryState = {
  lastPingAt?: number;
  latestVersion?: string;
  note?: string;
};

export type SuccessfulTelemetryState = TelemetryState & {
  lastPingAt: number;
  latestVersion: string;
};

export type TelemetryWorkerOperations = {
  "telemetry.readState": { input: undefined; output: TelemetryState };
  "telemetry.countRecentSessions": { input: { sinceMs: number }; output: number };
  "telemetry.persistSuccess": {
    input: { state: SuccessfulTelemetryState; updatedAtMs: number };
    output: SuccessfulTelemetryState;
  };
};
