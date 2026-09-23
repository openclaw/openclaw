export type FleetCellRecord = {
  tenantId: string;
  createdAtMs: number;
  image: string;
  runtime: "docker" | "podman";
  hostPort: number;
  containerName: string;
  dataDir: string;
};

export type ReserveFleetCellParams = Omit<FleetCellRecord, "hostPort"> & {
  requestedPort?: number;
};

export type FleetCellOperationName =
  | "create"
  | "start"
  | "stop"
  | "restart"
  | "upgrade"
  | "backup"
  | "restore"
  | "rm";

export type FleetRegistryWriteOperations = {
  "fleet.cell.reserve": {
    input: ReserveFleetCellParams & { operationOwner?: string };
    output: FleetCellRecord;
  };
  "fleet.cell.updateImage": {
    input: { tenantId: string; image: string; operationOwner?: string };
    output: void;
  };
  "fleet.cell.delete": { input: { tenantId: string; operationOwner?: string }; output: void };
  "fleet.operation.acquire": {
    input: { tenantId: string; operation: FleetCellOperationName; owner: string; nowMs?: number };
    output: void;
  };
  "fleet.operation.heartbeat": {
    input: { tenantId: string; owner: string; nowMs?: number };
    output: void;
  };
  "fleet.operation.release": { input: { tenantId: string; owner: string }; output: void };
};
