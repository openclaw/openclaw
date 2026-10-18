import { serialize } from "node:v8";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createSqliteWorkerClient as createClient,
  runSqliteWorkerClientOperation as runOperation,
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
    expect(dispatch).toHaveBeenLastCalledWith(
      serialize(command),
      undefined,
      undefined,
      undefined,
      undefined,
      requestClass,
    );
  };
  const input = { value: "synthetic-private-payload" };
  const cases = [
    ["audit.writer.process", "audit.writer.process"],
    ["audit.writer.prune", "audit.writer.prune"],
    ["stateLease.renew", "stateLease.renew"],
    ["worktrees.get", "worktrees.get"],
    ["worktrees.insert", "worktrees.insert"],
    ["worktrees.templates.has", "worktrees.templates.has"],
    ["worktrees.private-customer-123", "worktrees"],
    ["capture.recordEventWithPayload", "capture"],
    ["workerInference.complete", "workerInference"],
    ["session.entry.read", "session.entry.read"],
    ["session.actor.acceptInput", "session.actor.acceptInput"],
    ["session.actor.completeTurn", "session.actor.completeTurn"],
    ["session.lifecycle.project", "session.lifecycle.project"],
    ["transcript.prepare", "transcript.prepare"],
    ["transcript.commit", "transcript.commit"],
    ["session.actor.private-customer-123", "sessions"],
    ["pluginState.get", "plugin_state"],
    ["audit.private-customer-123", "audit"],
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
    ["publish", js, "claim", "transcript-projection.claim"],
    ["publish", js, "deleteChunk", "transcript-projection.deleteChunk"],
    ["publish", js, "appendChunk", "transcript-projection.appendChunk"],
    ["publish", js, "finalize", "transcript-projection.finalize"],
    ["publish", js, "private-customer-123", "domain_execute"],
    ["publish", "file:///synthetic-private-root/another.worker.js", "claim", "domain_execute"],
    ["publish", `${js}.private`, "claim", "domain_execute"],
    ["execute", undefined, "claim", "domain_execute"],
    ["execute", undefined, "transcript.prepare", "transcript.prepare"],
    ["execute", undefined, "transcript.commit", "transcript.commit"],
  ] as const;
  for (const [type, moduleUrl, innerType, requestClass] of domainCases) {
    await check(
      `database.domain.${type}`,
      { moduleUrl, command: { type: innerType, input } },
      requestClass,
    );
  }
  expect(dispatch).toHaveBeenCalledTimes(cases.length + domainCases.length);
});

it.each(["scope", "command"] as const)(
  "protects an accepted %s from idle reclamation",
  async (kind) => {
    const finish = createDeferredCore<string>();
    const release = vi.fn(async (_reclaiming: boolean) => {});
    const retireIdle = vi.fn(() => store.close());
    const { client, store } = clientFixture({
      dispatch: () => finish.promise,
      release,
      retireIdle,
    });
    const operation = () => finish.promise;
    const track = () => () => {};
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
