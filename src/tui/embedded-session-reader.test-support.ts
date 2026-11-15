import { expect, it, vi, type Mock } from "vitest";
import { createDeferred as deferred } from "../../test/helpers/promise.js";
import { createEmbeddedCallGateway } from "../agents/tools/embedded-gateway-stub.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";
import { sendMainChat } from "./embedded-backend.test-helpers.js";

export function createPreparedProjectionMethods(read: () => unknown) {
  return {
    present: vi.fn((record: { entry: { sessionId?: unknown }; target: { key: string } }) => ({
      key: record.target.key,
      sessionId: record.entry.sessionId,
    })),
    withPreparedExactRows: vi.fn(async (_queries: unknown, consume: (read: unknown) => unknown) =>
      consume(read()),
    ),
  };
}

export function registerEmbeddedSessionReaderTests<Projection extends { dispose: () => void }>({
  createBackend,
  sessionProjection: projection,
  createSessionRowProjectionMock: createProjection,
  listProjectedSessionsMock: listSessions,
  runSessionStartupMigrationMock: migrate,
  getRuntimeConfigMock: readConfig,
  refreshPreparedModelRuntimeSnapshotsMock: publish,
  agentCommandFromIngressMock: dispatch,
  unregisterConfigWriteListenerMock: unsubscribe,
  flushMicrotasks,
}: {
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
  const unavailable = (pending: Promise<unknown>) =>
    expect(pending).rejects.toThrow("Embedded session projection is unavailable");
  function startBackend() {
    const backend = createBackend();
    backend.start();
    return backend;
  }
  it("gates local turns and session reads on startup migration and publication", async () => {
    readConfig.mockReturnValue({});
    const nextConfig = { agents: { entries: { main: {} }, defaults: { model: "openai/next" } } };
    const migrating = deferred();
    const migration = deferred();
    migrate.mockImplementationOnce(() => {
      migrating.resolve();
      return migration.promise;
    });
    const publication = deferred();
    publish.mockReturnValueOnce(publication.promise);
    const backend = startBackend();
    const sent = sendMainChat(backend, "hello", "run-waits-for-published-runtime");
    const listed = backend.listSessions({ agentId: "work" });
    try {
      await migrating.promise;
      await flushMicrotasks();
      expect(publish).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(createProjection).not.toHaveBeenCalled();
      expect(listSessions).not.toHaveBeenCalled();
      readConfig.mockReturnValue(nextConfig);
      migration.resolve();
      await flushMicrotasks();
      expect(publish).toHaveBeenCalledWith(nextConfig);
      expect(dispatch).not.toHaveBeenCalled();
      publication.resolve();
      await Promise.all([sent, listed]);
      expect(migrate).toHaveBeenCalledWith({
        cfg: {},
        env: process.env,
        log: { info: expect.any(Function), warn: expect.any(Function) },
      });
      expect(listSessions).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    } finally {
      migration.resolve();
      publication.resolve();
      await Promise.allSettled([sent, listed]);
      await backend.stop();
    }
  });

  it("shares one resident projection between local lists and embedded session tools", async () => {
    const backend = startBackend();
    const opts = { agentId: "work", includeGlobal: true, search: "global" };
    try {
      await backend.listSessions(opts);
      await createEmbeddedCallGateway()({ method: "sessions.list", params: opts });
      expect(createProjection).toHaveBeenCalledOnce();
      expect(listSessions.mock.calls).toEqual([[{ projection, opts }], [{ projection, opts }]]);
      for (const sessionKey of ["agent:work:notes", "global", "unknown"]) {
        await backend.describeSession({ sessionKey, agentId: "work" });
        expect(listSessions).toHaveBeenLastCalledWith({
          projection,
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
    expect(projection.dispose).toHaveBeenCalledOnce();
    await unavailable(createEmbeddedCallGateway()({ method: "sessions.list" }));
  });

  it.each(["startup", "metadata"] as const)("stops held %s", async (stage) => {
    const entered = deferred();
    const held = deferred<{ sessions: unknown[] }>();
    const wait = () => {
      entered.resolve();
      return held.promise;
    };
    if (stage === "startup") {
      migrate.mockImplementationOnce(async () => {
        await wait();
      });
    } else {
      listSessions.mockImplementationOnce(wait);
    }
    const backend = startBackend();
    const rejected =
      stage === "metadata"
        ? unavailable(backend.describeSession({ sessionKey: "agent:work:notes" }))
        : undefined;
    try {
      await entered.promise;
      const stopped = backend.stop();
      if (stage === "startup") {
        held.resolve({ sessions: [] });
      }
      await stopped;
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(projection.dispose).toHaveBeenCalledOnce();
      held.resolve({ sessions: [{ key: "agent:work:notes", sessionId: "stopped-session" }] });
      await rejected;
      await unavailable(backend.listSessions());
    } finally {
      held.resolve({ sessions: [] });
      await backend.stop();
    }
  });
}
