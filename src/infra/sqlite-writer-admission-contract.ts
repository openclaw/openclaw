import type { ProfileAuthorityStatus } from "../state/user-profile-authority.js";
import type {
  SqliteWorkerExecutionAuthority,
  SqliteWorkerMaintenanceAuthority,
} from "./sqlite-worker-contract.js";
import type { SqliteWorkerRequestCustodyDescriptor } from "./sqlite-worker-request-custody.js";

export type SqliteWriterAdmissionResult =
  | ProfileAuthorityStatus
  | { kind: "connected"; lifetime: Int32Array<SharedArrayBuffer> };

export type SqliteBrokerAdmissionRequest = {
  custody: SqliteWorkerRequestCustodyDescriptor;
  executionAuthority?: SqliteWorkerExecutionAuthority;
  maintenanceAuthority?: SqliteWorkerMaintenanceAuthority;
  decision: Int32Array<SharedArrayBuffer>;
};
