import type { SqliteWorkerExecutionAuthority } from "../infra/sqlite-worker-contract.js";

const OPEN = 0;
const CLOSING = 1;
const REVOKED = 2;
const RETIRED = 3;

/** Each logical owner, native generation and borrower keeps its original cell. */
export class AgentDatabaseExecutionLifetime {
  readonly state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

  get open(): boolean {
    return Atomics.load(this.state, 0) === OPEN;
  }

  close(): void {
    Atomics.compareExchange(this.state, 0, OPEN, CLOSING);
  }

  reopen(): void {
    // Only failed logical cleanup can reopen; explicit revocation is permanent.
    Atomics.compareExchange(this.state, 0, CLOSING, OPEN);
  }

  revoke(): void {
    Atomics.store(this.state, 0, REVOKED);
  }

  retire(): void {
    Atomics.store(this.state, 0, RETIRED);
  }
}

export function readAgentDatabaseExecutionAuthority(
  authority: SqliteWorkerExecutionAuthority,
): boolean {
  return (
    Atomics.load(authority.logical, 0) === OPEN &&
    Atomics.load(authority.native, 0) === OPEN &&
    Atomics.load(authority.logical, 0) === OPEN &&
    Atomics.load(authority.native, 0) === OPEN
  );
}
