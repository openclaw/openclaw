import { expect, it, vi, type Mock } from "vitest";
import { createDeferred as deferred } from "../../test/helpers/promise.js";
import { createEmbeddedCallGateway } from "../agents/tools/embedded-gateway-stub.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";

export function createPreparedProjectionMethods(read: () => unknown) {
  const methods = {
    present: vi.fn((record: { entry: { sessionId?: unknown }; target: { key: string } }) => ({
      key: record.target.key,
      sessionId: record.entry.sessionId,
    })),
    withPreparedExactRows: vi.fn(
      async (_queries: unknown, consume: (read: unknown) => unknown) => ({
        kind: "complete" as const,
        value: consume(read()),
      }),
    ),
  };
  return methods;
}

export function registerEmbeddedSessionReaderTests<
  Projection extends { dispose: () => void },
>(params: {
  createBackend: () => EmbeddedTuiBackend;
  sessionProjection: Projection;
  createSessionRowProjectionMock: Mock<(_options?: unknown) => Promise<Projection>>;
  listProjectedSessionsMock: Mock<(_options?: unknown) => Promise<{ sessions: unknown[] }>>;
  runSessionStartupMigrationMock: Mock<(...args: unknown[]) => Promise<void>>;
  getRuntimeConfigMock: Mock<() => OpenClawConfig>;
  refreshPreparedModelRuntimeSnapshotsMock: Mock<
    (_config: unknown, _options?: unknown) => Promise<void>
  >;
  agentCommandFromIngressMock: Mock;
  unregisterConfigWriteListenerMock: Mock;
  flushMicrotasks: () => Promise<void>;
}) {
  const {
    createBackend,
    sessionProjection,
    createSessionRowProjectionMock,
    listProjectedSessionsMock,
    runSessionStartupMigrationMock,
    getRuntimeConfigMock,
    refreshPreparedModelRuntimeSnapshotsMock,
    agentCommandFromIngressMock,
    unregisterConfigWriteListenerMock,
    flushMicrotasks,
  } = params;

  it("publishes the current runtime after startup maintenance and before the first local turn", async () => {
    const initialConfig = { agents: { list: [{ id: "main" }] } };
    const nextConfig = { agents: { list: [{ id: "main" }], defaults: { model: "openai/next" } } };
    getRuntimeConfigMock.mockReturnValue(initialConfig);
    const migrating = deferred();
    const migration = deferred();
    runSessionStartupMigrationMock.mockImplementationOnce(() => {
      migrating.resolve();
      return migration.promise;
    });
    const publication = deferred();
    refreshPreparedModelRuntimeSnapshotsMock.mockReturnValueOnce(publication.promise);

    const backend = createBackend();
    backend.start();

    const send = backend.sendChat({
      sessionKey: "agent:main:main",
      message: "hello",
      runId: "run-waits-for-published-runtime",
    });
    try {
      await migrating.promise;
      expect(refreshPreparedModelRuntimeSnapshotsMock).not.toHaveBeenCalled();
      expect(agentCommandFromIngressMock).not.toHaveBeenCalled();

      getRuntimeConfigMock.mockReturnValue(nextConfig);
      migration.resolve();
      await flushMicrotasks();

      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(nextConfig);
      expect(agentCommandFromIngressMock).not.toHaveBeenCalled();

      publication.resolve();
      await send;
      await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1));
    } finally {
      migration.resolve();
      publication.resolve();
      await Promise.allSettled([send]);
      await backend.stop();
    }
  });

  it("shares one resident projection between local lists and embedded session tools", async () => {
    const backend = createBackend();
    backend.start();
    const opts = { agentId: "work", includeGlobal: true, search: "global" };
    try {
      await backend.listSessions(opts);
      await createEmbeddedCallGateway()({ method: "sessions.list", params: opts });
      expect(createSessionRowProjectionMock).toHaveBeenCalledOnce();
      expect(listProjectedSessionsMock).toHaveBeenCalledTimes(2);
      expect(listProjectedSessionsMock).toHaveBeenNthCalledWith(1, {
        projection: sessionProjection,
        opts,
      });
      expect(listProjectedSessionsMock).toHaveBeenNthCalledWith(2, {
        projection: sessionProjection,
        opts,
      });
      for (const sessionKey of ["agent:work:notes", "global", "unknown"]) {
        await backend.describeSession({ sessionKey, agentId: "work" });
        expect(listProjectedSessionsMock).toHaveBeenLastCalledWith({
          projection: sessionProjection,
          key: sessionKey,
          opts: {
            agentId: "work",
            includeGlobal: sessionKey === "global",
            includeUnknown: sessionKey === "unknown",
            limit: 1,
          },
        });
      }
    } finally {
      await backend.stop();
    }
    expect(sessionProjection.dispose).toHaveBeenCalledOnce();
    await expect(createEmbeddedCallGateway()({ method: "sessions.list" })).rejects.toThrow(
      "Embedded session projection is unavailable",
    );
  });

  it("disposes projection startup that finishes after shutdown begins", async () => {
    const starting = deferred();
    const startup = deferred();
    runSessionStartupMigrationMock.mockImplementationOnce(() => {
      starting.resolve();
      return startup.promise;
    });
    const backend = createBackend();
    backend.start();
    await starting.promise;
    const stopped = backend.stop();
    startup.resolve();
    await stopped;
    expect(unregisterConfigWriteListenerMock).toHaveBeenCalledOnce();
    expect(sessionProjection.dispose).toHaveBeenCalledOnce();
    await expect(backend.listSessions()).rejects.toThrow(
      "Embedded session projection is unavailable",
    );
  });

  it("gates session reads on the startup migration so legacy keys are never observed early", async () => {
    let resolveMigration: () => void = () => {};
    const migrationDone = new Promise<void>((resolve) => {
      resolveMigration = resolve;
    });
    runSessionStartupMigrationMock.mockReturnValueOnce(migrationDone);

    const backend = createBackend();
    backend.start();

    const listed = backend.listSessions({ agentId: "work" });
    await flushMicrotasks();
    expect(createSessionRowProjectionMock).not.toHaveBeenCalled();
    expect(listProjectedSessionsMock).not.toHaveBeenCalled();

    resolveMigration();
    await listed;
    expect(runSessionStartupMigrationMock).toHaveBeenCalledWith({
      cfg: {},
      env: process.env,
      log: {
        info: expect.any(Function),
        warn: expect.any(Function),
      },
    });
    expect(listProjectedSessionsMock).toHaveBeenCalledTimes(1);
    await backend.stop();
  });

  it("rejects metadata that settles after its embedded projection stops", async () => {
    const settled = deferred<{ sessions: unknown[] }>();
    listProjectedSessionsMock.mockReturnValueOnce(settled.promise);
    const backend = createBackend();
    backend.start();
    const description = backend.describeSession({ sessionKey: "agent:work:notes" });
    const rejected = expect(description).rejects.toThrow(
      "Embedded session projection is unavailable",
    );
    try {
      await vi.waitFor(() => expect(listProjectedSessionsMock).toHaveBeenCalledOnce());
      await backend.stop();
      settled.resolve({ sessions: [{ key: "agent:work:notes", sessionId: "stopped-session" }] });
      await rejected;
    } finally {
      settled.resolve({ sessions: [] });
      await backend.stop();
    }
  });
}
