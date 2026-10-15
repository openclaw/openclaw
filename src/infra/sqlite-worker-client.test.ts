import { serialize } from "node:v8";
import { expect, it, vi } from "vitest";
import type { Actor } from "./sqlite-worker-broker.types.js";
import {
  createSqliteWorkerClient,
  runSqliteWorkerClientOperation,
} from "./sqlite-worker-client.js";
import { SqliteWorkerSlotCustody } from "./sqlite-worker-request-custody.js";

type Operations = { write: { input: string; output: string } };
const closedError = { code: "closed", message: "SQLite worker store is closed" };

function createActor(): Actor {
  const custody = new SqliteWorkerSlotCustody().createRequest();
  custody.activate();
  custody.accept();
  custody.post();
  return {
    nativeStopped: Promise.resolve(),
    markNativeStopped() {},
    id: 1,
    key: "client-fixture",
    databasePath: "/fixture/state.sqlite",
    stateAccess: {
      canonicalPath: "/fixture/state.sqlite",
      assertAccessAllowed() {},
      assertReadAllowed() {},
    },
    pathReferences: new Map([["/fixture/state.sqlite", 1]]),
    moduleUrl: "file:///fixture/sqlite-backend.js",
    inputHash: "client-fixture",
    get slot(): never {
      throw new Error("Client scope must not access the broker's native Worker slot");
    },
    references: 1,
    opened: Promise.resolve(),
    openDispatch: { custody },
    initialized: true,
    backendClosed: false,
  };
}

it.each(["missing", "sealed"] as const)(
  "refuses a %s client before entering an operation or dispatching work",
  async (boundary) => {
    const dispatch = vi.fn(async () => "committed");
    const { client, store } = createSqliteWorkerClient<Operations>({
      actor: createActor(),
      isDraining: () => boundary === "sealed",
      isAvailable: () => true,
      dispatch,
      release: async () => {},
    });
    const operation = vi.fn(() => store.execute({ type: "write", input: "must not enter" }));
    const track = vi.fn(() => () => {});
    const assertCurrent = vi.fn();
    const createAdmission = vi.fn(() => {
      throw new Error("Refused operation must not acquire admission");
    });

    await expect(
      runSqliteWorkerClientOperation(
        boundary === "missing" ? undefined : client,
        operation,
        undefined,
        track,
        assertCurrent,
        createAdmission,
      ),
    ).rejects.toMatchObject(closedError);
    expect(operation).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(createAdmission).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    await store.close();
  },
);

it("attributes queued commands without changing wire bytes or exposing private command suffixes", async () => {
  type DiagnosticOperations = Record<string, { input: unknown; output: string }>;
  const dispatch = vi
    .fn<Parameters<typeof createSqliteWorkerClient<DiagnosticOperations>>[0]["dispatch"]>()
    .mockResolvedValue("committed");
  const { store } = createSqliteWorkerClient<DiagnosticOperations>({
    actor: createActor(),
    isDraining: () => false,
    isAvailable: () => true,
    dispatch,
    release: async () => {},
  });
  const cases = [
    ["audit.writer.process", "audit.writer.process"],
    ["audit.writer.prune", "audit.writer.prune"],
    ["database.inspectIdle", "database.inspectIdle"],
    ["stateLease.renew", "stateLease.renew"],
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
  try {
    for (const [type, requestClass] of cases) {
      const command = { type, input: { value: "synthetic-private-payload" } };
      await expect(store.execute(command)).resolves.toBe("committed");
      expect(dispatch).toHaveBeenLastCalledWith(
        serialize(command),
        undefined,
        undefined,
        undefined,
        undefined,
        requestClass,
      );
    }
    const projectionModule =
      "file:///synthetic-private-root/config/sessions/session-transcript-projection-publication.worker";
    const domainCases = [
      [
        "database.domain.publish",
        `${projectionModule}.js`,
        "preflight",
        "transcript-projection.preflight",
      ],
      ["database.domain.publish", `${projectionModule}.ts`, "sweep", "transcript-projection.sweep"],
      ["database.domain.publish", `${projectionModule}.js`, "claim", "transcript-projection.claim"],
      [
        "database.domain.publish",
        `${projectionModule}.js`,
        "deleteChunk",
        "transcript-projection.deleteChunk",
      ],
      [
        "database.domain.publish",
        `${projectionModule}.js`,
        "appendChunk",
        "transcript-projection.appendChunk",
      ],
      [
        "database.domain.publish",
        `${projectionModule}.js`,
        "finalize",
        "transcript-projection.finalize",
      ],
      [
        "database.domain.publish",
        `${projectionModule}.js`,
        "private-customer-123",
        "domain_execute",
      ],
      [
        "database.domain.publish",
        "file:///synthetic-private-root/another.worker.js",
        "claim",
        "domain_execute",
      ],
      ["database.domain.publish", `${projectionModule}.js.private`, "claim", "domain_execute"],
      ["database.domain.execute", undefined, "claim", "domain_execute"],
      ["database.domain.execute", undefined, "transcript.prepare", "transcript.prepare"],
      ["database.domain.execute", undefined, "transcript.commit", "transcript.commit"],
    ] as const;
    for (const [type, moduleUrl, innerType, requestClass] of domainCases) {
      const command = {
        type,
        input: {
          moduleUrl,
          command: { type: innerType, input: { value: "synthetic-private-payload" } },
        },
      };
      await expect(store.execute(command)).resolves.toBe("committed");
      expect(dispatch).toHaveBeenLastCalledWith(
        serialize(command),
        undefined,
        undefined,
        undefined,
        undefined,
        requestClass,
      );
    }
    expect(dispatch).toHaveBeenCalledTimes(cases.length + domainCases.length);
  } finally {
    await store.close();
  }
});
