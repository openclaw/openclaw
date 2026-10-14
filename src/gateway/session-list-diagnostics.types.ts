export type SessionListPhase =
  | "setup"
  | "materialize"
  | "storeLoad"
  | "filterSetup"
  | "rows"
  | "sharing"
  | "decoration"
  | "visibilityRepair"
  | "response"
  | "handlerExit";

type SessionListProjectionTiming = {
  prepareSyncMs: number;
  rowSyncMs: number;
  yieldWaitMs: number;
  yieldCount: number;
};

export type SessionListDiagnostics = {
  startSyncCpu: () => NodeJS.CpuUsage | undefined;
  finishSyncCpu: (
    metric: "prepareThreadCpuMs" | "rowThreadCpuMs" | "responseThreadCpuMs",
    started: NodeJS.CpuUsage | undefined,
  ) => void;
  mark: (phase: SessionListPhase) => void;
  projection: SessionListProjectionTiming & {
    selectedRowCount: number;
    dirtyRowCount: number;
    materializedRowCount: number;
    reusedRowCount: number;
  };
};
