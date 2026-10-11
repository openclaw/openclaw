import { threadId } from "node:worker_threads";
import type {
  PluginStateOperationHandler,
  PluginStateOperationTransaction,
} from "./plugin-state-store.types.js";

export type FixtureOperations = {
  read: { input: { store: number; key: string }; output: { value: unknown; threadId: number } };
  move: {
    input: { value: string };
    output: { before: unknown[]; after: unknown[]; threadId: number };
  };
  cache: { input: undefined; output: unknown[] };
  escape: { input: undefined; output: boolean };
};

let previous: PluginStateOperationTransaction | undefined;
export const execute: PluginStateOperationHandler<FixtureOperations> = (command, tx) => {
  switch (command.type) {
    case "read":
      return { value: tx.lookup(command.input.store, command.input.key), threadId };
    case "move": {
      const before = tx.lookupMany([
        { store: 0, key: "key" },
        { store: 1, key: "key" },
      ]);
      tx.delete(0, "key");
      tx.set(1, "key", command.input.value);
      return {
        before,
        after: tx.lookupMany([
          { store: 0, key: "key" },
          { store: 1, key: "key" },
        ]),
        threadId,
      };
    }
    case "cache": {
      const first = tx.entries(0).map((entry) => entry.value);
      tx.set(0, "new", "new");
      const second = tx.entries(0).map((entry) => entry.value);
      const evicted = tx.lookup(0, "old");
      tx.delete(0, "new");
      return [first, second, evicted, tx.entries(0)];
    }
    case "escape": {
      if (previous) {
        previous.lookup(0, "key");
      }
      previous = tx;
      return true;
    }
  }
  throw new Error("Unknown plugin state fixture command");
};

export async function asynchronousHandler(_command: unknown, tx: PluginStateOperationTransaction) {
  tx.set(0, "key", "uncommitted");
  await Promise.resolve();
  tx.set(0, "key", "escaped");
}
