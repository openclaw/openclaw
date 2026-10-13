import type { ProfileAuthorityStatus } from "../state/user-profile-authority.js";
import type { SqliteWorkerRequestCustodyDescriptor } from "./sqlite-worker-request-custody.js";

export type SqliteWriterAdmissionResult =
  | ProfileAuthorityStatus
  | { kind: "connected"; lifetime: Int32Array<SharedArrayBuffer> };

export type SqliteBrokerAdmissionRequest = {
  custody: SqliteWorkerRequestCustodyDescriptor;
  decision: Int32Array<SharedArrayBuffer>;
};
