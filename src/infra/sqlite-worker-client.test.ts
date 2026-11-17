import { deserialize, serialize } from "node:v8";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createSqliteWorkerClient as createClient,
  runSqliteWorkerClientOperation as runOperation,
  sqliteWorkerTransferredInputBytes,
} from "./sqlite-worker-client.js";
import { createSqliteWorkerClientActor } from "./sqlite-worker-client.test-support.js";

const closedError = { code: "closed", message: "SQLite worker store is closed" };
type DiagnosticOperations = Record<string, { input: unknown; output: string }>;
type Dispatch = Parameters<typeof createClient<DiagnosticOperations>>[0]["dispatch"];
function clientFixture<
  Operations extends DiagnosticOperations = { write: { input: string; output: string } },
>(options: Partial<Parameters<typeof createClient<Operations>>[0]> = {}) {
  const fixture = createClient<Operations>({
    actor: createSqliteWorkerClientActor(),
    isDraining: () => false,
    isAvailable: () => true,
    dispatch: vi.fn(async () => "committed"),
    release: async () => {},
    ...options,
  });
  onTestFinished(() => fixture.store.close());
  return fixture;
}

it.each(["missing", "sealed"] as const)(
  "refuses a %s client before entering an operation or dispatching work",
  async (boundary) => {
    const dispatch = vi.fn(async () => "committed");
    const { client, store } = clientFixture({
      isDraining: () => boundary === "sealed",
      dispatch,
    });
    const operation = vi.fn(() => store.execute({ type: "write", input: "must not enter" }));
    const track = vi.fn(() => () => {});
    const assertCurrent = vi.fn();
    const createAdmission = vi.fn(() => {
      throw new Error("Refused operation must not acquire admission");
    });
    const target = boundary === "missing" ? undefined : client;
    await expect(
      runOperation(target, operation, undefined, track, assertCurrent, createAdmission),
    ).rejects.toMatchObject(closedError);
    for (const callback of [operation, track, assertCurrent, createAdmission, dispatch]) {
      expect(callback).not.toHaveBeenCalled();
    }
  },
);

it("attributes queued commands without changing wire bytes or exposing private command suffixes", async () => {
  const dispatch = vi.fn<Dispatch>().mockResolvedValue("committed");
  const { store } = clientFixture<DiagnosticOperations>({ dispatch });
  const check = async (type: string, input: unknown, requestClass: string) => {
    const command = { type, input };
    await expect(store.execute(command)).resolves.toBe("committed");
    expect(dispatch.mock.lastCall?.[0].payload).toEqual(serialize(command));
    expect(dispatch.mock.lastCall?.[5]).toBe(requestClass);
  };
  const input = { value: "synthetic-private-payload" };
  const cases = [
    ["audit.writer.process", "audit.writer.process"],
    ["worktrees.private-customer-123", "worktrees"],
    ["session.entry.read", "session.entry.read"],
    ["session.actor.private-customer-123", "sessions"],
    ["pluginState.get", "plugin_state"],
    ["private-customer-123.execute", "execute"],
    ["unrecognized", "execute"],
  ] as const;
  for (const [type, requestClass] of cases) {
    await check(type, input, requestClass);
  }
  const projectionModule =
    "file:///synthetic-private-root/config/sessions/session-transcript-projection-publication.worker";
  const js = `${projectionModule}.js`;
  const domainCases = [
    ["publish", js, "preflight", "transcript-projection.preflight"],
    ["publish", `${projectionModule}.ts`, "sweep", "transcript-projection.sweep"],
    ["publish", js, "private-customer-123", "domain_execute"],
    ["publish", "file:///synthetic-private-root/another.worker.js", "claim", "domain_execute"],
    ["publish", `${js}.private`, "claim", "domain_execute"],
    ["execute", undefined, "claim", "domain_execute"],
    ["execute", undefined, "transcript.prepare", "transcript.prepare"],
  ] as const;
  for (const [type, moduleUrl, innerType, requestClass] of domainCases) {
    await check(
      `database.domain.${type}`,
      { moduleUrl, command: { type: innerType, input } },
      requestClass,
    );
  }
});

it.each(["scope", "command"] as const)(
  "protects an accepted %s from idle reclamation",
  async (kind) => {
    const finish = createDeferredCore<string>();
    const release = vi.fn(async (_reclaiming: boolean) => {});
    const retireIdle = vi.fn(() => store.close());
    const operation = () => finish.promise;
    const track = () => () => {};
    const { client, store } = clientFixture({
      dispatch: () => finish.promise,
      release,
      retireIdle,
    });
    const accepted =
      kind === "scope"
        ? runOperation(client, operation, undefined, track)
        : store.execute({ type: "write", input: "accepted" });
    try {
      expect(client.retireIdle?.()).toBeUndefined();
      expect(retireIdle).not.toHaveBeenCalled();
    } finally {
      finish.resolve("committed");
      await accepted;
    }
    await client.retireIdle?.();
    expect(release).toHaveBeenCalledWith(true);
    await expect(store.execute({ type: "write", input: "after close" })).rejects.toMatchObject(
      closedError,
    );
  },
);

it("moves publication bytes without detaching the retained recovery pack", async () => {
  const dispatch = vi.fn<Dispatch>().mockResolvedValue("committed");
  const { store } = clientFixture<DiagnosticOperations>({ dispatch });
  const recoveryPack = Uint8Array.from([3, 1, 4]);
  const publicationPack = new Uint8Array(recoveryPack);
  await store.execute(
    { type: "write", input: { journalPack: undefined } },
    { transferredInput: { journalPack: publicationPack } },
  );
  expect(publicationPack.byteLength).toBe(0);
  expect(recoveryPack).toEqual(Uint8Array.from([3, 1, 4]));
  expect(deserialize(dispatch.mock.lastCall![0].payload)).toEqual({
    type: "write",
    input: { journalPack: undefined },
  });
  expect(dispatch.mock.lastCall![0].transferredInput?.journalPack).toEqual(recoveryPack);
});

it("does not consume publication bytes for already-canceled work", async () => {
  const dispatch = vi.fn<Dispatch>().mockResolvedValue("committed");
  const { store } = clientFixture<DiagnosticOperations>({ dispatch });
  const publicationPack = Uint8Array.from([2, 7]);
  await expect(
    store.execute(
      { type: "write", input: {} },
      {
        signal: AbortSignal.abort(new Error("canceled")),
        transferredInput: { journalPack: publicationPack },
      },
    ),
  ).rejects.toThrow("canceled");
  expect(publicationPack).toEqual(Uint8Array.from([2, 7]));
  expect(dispatch).not.toHaveBeenCalled();
});

it("charges aliased transfer views once at their full allocation size", () => {
  const allocation = new Uint8Array(128);
  expect(
    sqliteWorkerTransferredInputBytes({
      first: allocation.subarray(0, 4),
      second: allocation.subarray(8, 12),
    }),
  ).toBe(128);
});
