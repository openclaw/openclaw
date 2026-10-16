import {
  SqliteWorkerError,
  type SqliteWorkerRequestCustodyDescriptor,
} from "./sqlite-worker-contract.js";
export type { SqliteWorkerRequestCustodyDescriptor } from "./sqlite-worker-contract.js";

const ACTIVE = 1;
const DISPATCHED = 2;
const POST_ATTEMPTED = 4;
const CANCELED = 8;
const RETIRED = 16;

function active(state: number): boolean {
  return (state & ACTIVE) !== 0 && (state & (CANCELED | RETIRED)) === 0;
}

/** Exact buffers retain generations; request IDs never identify authority. */
export function readSqliteWorkerRequestCustody(
  descriptor: SqliteWorkerRequestCustodyDescriptor,
): boolean {
  return Atomics.load(descriptor.slot, 0) === 1 && active(Atomics.load(descriptor.request, 0));
}

export class SqliteWorkerSlotCustody {
  readonly state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

  constructor() {
    Atomics.store(this.state, 0, 1);
  }

  createRequest(): SqliteWorkerRequestCustody {
    return new SqliteWorkerRequestCustody(this.state);
  }

  retire(): void {
    Atomics.store(this.state, 0, 0);
  }
}

export class SqliteWorkerRequestCustody {
  readonly descriptor: SqliteWorkerRequestCustodyDescriptor;

  constructor(slot: Int32Array<SharedArrayBuffer>) {
    this.descriptor = {
      slot,
      request: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    };
  }

  activate(): void {
    if (Atomics.compareExchange(this.descriptor.request, 0, 0, ACTIVE) !== 0) {
      throw new SqliteWorkerError("SQLite worker request custody was already used", "closed");
    }
  }

  assertCurrent(): void {
    if (!readSqliteWorkerRequestCustody(this.descriptor)) {
      throw new SqliteWorkerError("SQLite worker job is no longer current", "closed");
    }
  }

  get dispatched(): boolean {
    return (Atomics.load(this.descriptor.request, 0) & DISPATCHED) !== 0;
  }

  get postAttempted(): boolean {
    return (Atomics.load(this.descriptor.request, 0) & POST_ATTEMPTED) !== 0;
  }

  accept(): void {
    this.assertCurrent();
    Atomics.or(this.descriptor.request, 0, DISPATCHED);
  }

  post(): void {
    Atomics.or(this.descriptor.request, 0, POST_ATTEMPTED);
  }

  cancel(): void {
    // Accepted writes retain their custody until native outcome and receipts settle.
    if (!this.dispatched) {
      Atomics.or(this.descriptor.request, 0, CANCELED);
    }
  }

  retire(): void {
    // Dispatch history remains available to classify settlement after revocation.
    Atomics.or(this.descriptor.request, 0, RETIRED);
  }
}
