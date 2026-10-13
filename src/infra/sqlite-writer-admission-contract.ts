import type { MessagePort } from "node:worker_threads";
import type {
  ProfileAuthorityDescriptor,
  ProfileAuthorityStatus,
} from "../state/user-profile-authority.js";
import type { SqliteWorkerRequestCustodyDescriptor } from "./sqlite-worker-request-custody.js";

/** Profile checks alone do not grant a native write or replace the final host COMMIT guard. */
export type SqliteProfileAdmissionRequest = {
  kind: "assert-bound-revision" | "read-current-settled-facts";
  authority: ProfileAuthorityDescriptor;
};
export type SqliteProfileAdmissionResult = ProfileAuthorityStatus;

export type SqliteWriterAdmissionConnection = {
  port: MessagePort;
  lifetime: Int32Array<SharedArrayBuffer>;
};

export type SqliteWriterAdmissionRequest =
  | SqliteProfileAdmissionRequest
  | { kind: "connect"; port: MessagePort };

export type SqliteWriterAdmissionResult =
  | SqliteProfileAdmissionResult
  | { kind: "connected"; lifetime: Int32Array<SharedArrayBuffer> };

export type SqliteBrokerAdmissionRequest = {
  custody: SqliteWorkerRequestCustodyDescriptor;
  decision: Int32Array<SharedArrayBuffer>;
};
