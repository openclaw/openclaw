import { deserialize, serialize } from "node:v8";
import type { SqliteWorkerStoreOptions } from "../sqlite-worker-broker.types.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../sqlite-worker-contract.js";
import {
  isSqliteWorkerStoreAvailable,
  openSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
  runSqliteWorkerStoreWrite,
} from "../sqlite-worker-store.js";
import { observeDatabaseRequest } from "./observation.js";
import type { DatabaseEngineInput } from "./types.js";

type EngineStoreOptions = SqliteWorkerStoreOptions & { existingOnly?: false; target?: never };

class EngineWorkerStore<
  Operations extends SqliteWorkerOperations,
> implements SqliteWorkerStore<Operations> {
  private reopening?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;

  constructor(
    private readonly options: EngineStoreOptions,
    private readonly input: DatabaseEngineInput,
    private store: SqliteWorkerStore<Operations>,
  ) {}

  async current(): Promise<SqliteWorkerStore<Operations>> {
    if (this.closed) {
      throw new SqliteWorkerError("Database engine store is closed", "closed");
    }
    if (!isSqliteWorkerStoreAvailable(this.store)) {
      this.reopening ??= (async () => {
        await this.store.close();
        this.store = await observeDatabaseRequest(this.input ? "postgres" : "sqlite", () =>
          openSqliteWorkerStore<Operations>(this.options),
        );
      })().finally(() => {
        this.reopening = undefined;
      });
      await this.reopening;
      if (this.closed) {
        throw new SqliteWorkerError("Database engine store is closed", "closed");
      }
    }
    return this.store;
  }

  async execute<Key extends keyof Operations>(
    command: { type: Key; input: Operations[Key]["input"] },
    options?: { signal?: AbortSignal },
  ): Promise<Operations[Key]["output"]> {
    let store = this.store;
    let captured = command;
    if (this.closed || !isSqliteWorkerStoreAvailable(store)) {
      const payload = serialize(command);
      store = await this.current();
      captured = deserialize(payload);
    }
    // Never replay a command: a failed worker may have committed before losing its reply.
    return observeDatabaseRequest(this.input ? "postgres" : "sqlite", () =>
      store.execute(captured, options),
    );
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      await this.reopening?.catch(() => undefined);
      await observeDatabaseRequest(this.input ? "postgres" : "sqlite", () => this.store.close());
    })().catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}

export async function openEngineWorkerStore<Operations extends SqliteWorkerOperations>(
  options: EngineStoreOptions,
  input: DatabaseEngineInput,
): Promise<SqliteWorkerStore<Operations>> {
  const captured = {
    ...options,
    moduleUrl: new URL(options.moduleUrl),
    input: deserialize(serialize(options.input)),
  };
  const store = await observeDatabaseRequest(input ? "postgres" : "sqlite", () =>
    openSqliteWorkerStore<Operations>(captured),
  );
  return new EngineWorkerStore(captured, input, store);
}

/** The selected adapter owns the host admission envelope, not a store facade. */
export async function runEngineStoreOperation<Operations extends SqliteWorkerOperations, T>(
  store: SqliteWorkerStore<Operations>,
  input: DatabaseEngineInput,
  writes: boolean,
  operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => Promise<T>,
  assertCurrent: (() => void) | undefined,
  databasePath: string,
): Promise<T> {
  const current: SqliteWorkerStore<Operations> =
    store instanceof EngineWorkerStore ? await store.current() : store;
  const observed = (scope: Pick<SqliteWorkerStore<Operations>, "execute">) =>
    operation({
      execute: (command, options) =>
        observeDatabaseRequest(input ? "postgres" : "sqlite", () =>
          scope.execute(command, options),
        ),
    });
  if (input && writes) {
    return runSqliteWorkerStoreWrite(current, observed, assertCurrent ?? (() => {}), [
      databasePath,
    ]);
  }
  return assertCurrent
    ? runSqliteWorkerStoreOperation(current, observed, undefined, assertCurrent)
    : observed(current);
}
