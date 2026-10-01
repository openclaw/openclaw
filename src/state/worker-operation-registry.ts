import type {
  SqliteWorkerCommand,
  SqliteWorkerOperations,
} from "../infra/sqlite-worker-contract.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";

export type WorkerOperationContext = {
  open: () => OpenClawStateDatabase;
  stateOptions: () => { path: string; env: NodeJS.ProcessEnv };
};

export type WorkerOperationHandlers<Context = WorkerOperationContext> = Record<
  string,
  (input: never, context: Context) => unknown
>;

export type WorkerOperations<Handlers extends WorkerOperationHandlers<never>> = {
  [Key in keyof Handlers]: {
    input: Parameters<Handlers[Key]>[0];
    output: ReturnType<Handlers[Key]>;
  };
};

type Namespace<Key> = Key extends `${infer Domain}.${string}` ? Domain : never;
type DomainLoaders<Operations extends SqliteWorkerOperations, Context, Domains extends string> = {
  [Domain in Domains]: () => Promise<{
    [Key in keyof Operations as Key extends Domain | `${Domain}.${string}` ? Key : never]: (
      input: Operations[Key]["input"],
      context: Context,
    ) => Operations[Key]["output"];
  }>;
};

export function createWorkerOperationRegistry<
  Operations extends SqliteWorkerOperations,
  Context = WorkerOperationContext,
  Domains extends string = Namespace<keyof Operations>,
>(loaders: DomainLoaders<Operations, Context, Domains>) {
  const domains = new Map<
    string,
    {
      load: () => Promise<WorkerOperationHandlers<Context>>;
      handlers?: WorkerOperationHandlers<Context>;
    }
  >(
    Object.entries<() => Promise<WorkerOperationHandlers<Context>>>(loaders).map(([name, load]) => [
      name,
      { load: createLazyRuntimeModule(load) },
    ]),
  );
  const domainFor = (type: PropertyKey) =>
    typeof type === "string"
      ? (domains.get(type) ?? domains.get(type.slice(0, type.indexOf("."))))
      : undefined;
  const handlerFor = (type: PropertyKey) => {
    const handlers = domainFor(type)?.handlers;
    return handlers && Object.hasOwn(handlers, type) ? handlers[String(type)] : undefined;
  };
  return {
    prepare(type: PropertyKey): Promise<void> | undefined {
      const domain = domainFor(type);
      if (domain && !domain.handlers) {
        return domain.load().then((handlers) => {
          domain.handlers = handlers;
        });
      }
      return undefined;
    },
    has(command: {
      type: PropertyKey;
      input: unknown;
    }): command is SqliteWorkerCommand<Operations> {
      return handlerFor(command.type) !== undefined;
    },
    execute(command: SqliteWorkerCommand<Operations>, context: Context) {
      const handler = handlerFor(command.type);
      if (!handler) {
        throw new Error(`Worker operation is not prepared: ${String(command.type)}`);
      }
      // SAFETY: The typed loader binds each key to its input/output; lookup erases that correlation.
      const execute = handler as (
        input: Operations[keyof Operations]["input"],
        context: Context,
      ) => Operations[keyof Operations]["output"];
      return execute(command.input, context);
    },
  };
}
