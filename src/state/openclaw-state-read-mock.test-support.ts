import type { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";

type ReadSource = ReturnType<typeof captureOpenClawStateReadSource>;
type ReadTransport = ReturnType<ReadSource["createTransport"]>;

export function createMockStateReadSource(transport: {
  read: (...args: Parameters<ReadTransport["startRead"]>) => ReturnType<ReadTransport["startRead"]>;
  close: () => Promise<void>;
}): ReadSource {
  return {
    own: () => () => {},
    createTransport: () => ({
      startValidateFresh: async () => {},
      startRead: async (...args) => await transport.read(...args),
      startClose: async () => await transport.close(),
    }),
  };
}
