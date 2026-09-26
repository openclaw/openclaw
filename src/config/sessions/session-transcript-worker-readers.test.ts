import { describe, expect, it } from "vitest";
import {
  createSessionHistoryWorkerReaders,
  type SessionHistoryWorkerRequestRunner,
} from "./session-transcript-worker-readers.js";

describe("session transcript worker readers", () => {
  it("materializes exact-entry env before the worker boundary", async () => {
    let prepared: unknown;
    const runRequest = (async (prepare: () => unknown) => {
      prepared = prepare();
      structuredClone(prepared);
      return undefined as never;
    }) as SessionHistoryWorkerRequestRunner;

    const readers = createSessionHistoryWorkerReaders(runRequest);
    const env = new Proxy(
      { OPENCLAW_STATE_DIR: "C:/synthetic-state", Path: "C:/synthetic-bin" },
      {},
    );

    await readers.readExactEntries({
      database: { agentId: "main", path: "C:/synthetic-state/agent.sqlite" },
      env,
      sessionKeys: ["agent:main:main"],
    });

    expect(prepared).toMatchObject({
      kind: "session-exact-entries",
      env: {
        OPENCLAW_STATE_DIR: "C:/synthetic-state",
        Path: "C:/synthetic-bin",
      },
      sessionKeys: ["agent:main:main"],
    });
    expect((prepared as { env: unknown }).env).not.toBe(env);
  });
});
