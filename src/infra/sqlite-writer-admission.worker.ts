import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readProfileAuthority,
  type ProfileAuthorityDescriptor,
} from "../state/user-profile-authority.js";
import type { SqliteProfileAdmissionResult } from "./sqlite-writer-admission-contract.js";
import { serveWorkerTasks } from "./worker-task-server.js";

function isProfileAuthority(value: unknown): value is ProfileAuthorityDescriptor {
  return (
    isRecord(value) &&
    value.generation instanceof SharedArrayBuffer &&
    value.generation.byteLength === 2 * Int32Array.BYTES_PER_ELEMENT &&
    isRecord(value.lifetime) &&
    value.lifetime.revision instanceof SharedArrayBuffer &&
    value.lifetime.revision.byteLength === BigInt64Array.BYTES_PER_ELEMENT &&
    typeof value.lifetime.epoch === "bigint" &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        isRecord(entry) &&
        entry.state instanceof SharedArrayBuffer &&
        entry.state.byteLength === 2 * Int32Array.BYTES_PER_ELEMENT &&
        (entry.revision === undefined || Number.isInteger(entry.revision)),
    )
  );
}

serveWorkerTasks<SqliteProfileAdmissionResult>((input) => {
  if (
    !isRecord(input) ||
    (input.kind !== "assert-bound-revision" && input.kind !== "read-current-settled-facts") ||
    !isProfileAuthority(input.authority) ||
    input.authority.entries.some((entry) =>
      input.kind === "assert-bound-revision"
        ? entry.revision === undefined
        : entry.revision !== undefined,
    )
  ) {
    throw new Error("SQLite admission requires a typed profile authority descriptor");
  }
  return readProfileAuthority(input.authority);
});
