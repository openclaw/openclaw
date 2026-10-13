export type SqliteWorkerMaintenanceAuthority = {
  scope: Int32Array<SharedArrayBuffer>;
  owners: readonly Int32Array<SharedArrayBuffer>[];
  frame?: Int32Array<SharedArrayBuffer>;
};

const OPEN = 0;
const DRAINING = 1;
const CLOSED = 2;

/** Scope closure stops new entries, while exact accepted frames retain cleanup custody. */
export class MaintenanceScopeLifetime {
  readonly state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

  get closed(): boolean {
    return Atomics.load(this.state, 0) === CLOSED;
  }

  admits(frame?: Int32Array<SharedArrayBuffer>): boolean {
    const phase = Atomics.load(this.state, 0);
    return (
      phase === OPEN || (phase === DRAINING && frame !== undefined && Atomics.load(frame, 0) === 1)
    );
  }

  drain(): void {
    Atomics.store(this.state, 0, DRAINING);
  }

  reopen(): void {
    Atomics.compareExchange(this.state, 0, DRAINING, OPEN);
  }

  close(): void {
    Atomics.store(this.state, 0, CLOSED);
  }
}

/** A frame or resource claim has its own identity; retiring one never revokes its scope. */
export class MaintenanceContinuationLifetime {
  readonly state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

  constructor() {
    Atomics.store(this.state, 0, 1);
  }

  get active(): boolean {
    return Atomics.load(this.state, 0) === 1;
  }

  retire(): void {
    Atomics.store(this.state, 0, 0);
  }
}

function isMaintenanceAuthorityCurrent(authority: SqliteWorkerMaintenanceAuthority): boolean {
  if (authority.owners.some((owner) => Atomics.load(owner, 0) === CLOSED)) {
    return false;
  }
  const phase = Atomics.load(authority.scope, 0);
  return (
    phase === OPEN ||
    (phase === DRAINING && authority.frame !== undefined && Atomics.load(authority.frame, 0) === 1)
  );
}

export function isSqliteWorkerMaintenanceAuthorityCurrent(
  authority: SqliteWorkerMaintenanceAuthority,
): boolean {
  return isMaintenanceAuthorityCurrent(authority) && isMaintenanceAuthorityCurrent(authority);
}
