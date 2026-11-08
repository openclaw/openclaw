import { expect, it, vi, type Mock } from "vitest";
import * as sessionRuntimeOwnership from "../agents/harness/session-runtime-ownership.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";

export function registerEmbeddedHistoryProjectionTests(params: {
  createBackend: () => EmbeddedTuiBackend;
  loadSessionEntry: Mock;
  describe: Mock;
  present: Mock;
  withPreparedExactRows: Mock;
  buildSessionRow: Mock;
  readAcpMetadata: Mock<
    typeof import("../acp/runtime/session-meta-readonly.js").readAcpSessionMetaForEntries
  >;
}) {
  async function loadHistory(opts: Parameters<EmbeddedTuiBackend["loadHistory"]>[0]) {
    const backend = params.createBackend();
    backend.start();
    try {
      return await backend.loadHistory(opts);
    } finally {
      await backend.stop();
    }
  }

  it("presents captured history and the selected agent's verbose default within its read frame", async () => {
    const entry = { sessionId: "captured-session", lifecycleRevision: "captured-revision" };
    const target = { key: "global", agentId: "work", storePath: "/tmp/physical.sqlite" };
    params.loadSessionEntry.mockReturnValue({
      cfg: {
        agents: {
          defaults: { verboseDefault: "off" },
          entries: { main: {}, work: { verboseDefault: "full" } },
        },
      },
      agentId: target.agentId,
      canonicalKey: target.key,
      storePath: "/tmp/logical.sqlite",
      readSource: { path: target.storePath },
      entry,
    });
    let active = false;
    const row = {
      get entry() {
        expect(active, "history identity must be validated before the read expires").toBe(true);
        return entry;
      },
    };
    const describe = vi.fn(() => row);
    const present = vi.fn((current: typeof row) => {
      expect(active, "history metadata must be presented before the read expires").toBe(true);
      return { key: target.key, sessionId: current.entry.sessionId };
    });
    params.withPreparedExactRows.mockImplementationOnce(async (queries, consume) => {
      expect(queries({})).toEqual([target]);
      active = true;
      try {
        return consume({ describe, present });
      } finally {
        active = false;
      }
    });
    expect(await loadHistory({ sessionKey: "global", agentId: "work" })).toMatchObject({
      sessionId: entry.sessionId,
      verboseLevel: "full",
      sessionInfo: { key: target.key, sessionId: entry.sessionId },
    });
    expect(describe).toHaveBeenCalledExactlyOnceWith(target);
    expect(params.present).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: "replacement-session", lifecycleRevision: "previous-revision" },
    { sessionId: "previous-session", lifecycleRevision: "replacement-revision" },
  ])("does not attach a replacement session row to captured history: %j", async (currentEntry) => {
    params.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "main",
      canonicalKey: "agent:main:main",
      entry: { sessionId: "previous-session", lifecycleRevision: "previous-revision" },
    });
    params.describe.mockReturnValue({ entry: currentEntry });
    const result = await loadHistory({ sessionKey: "agent:main:main" });
    expect(result.sessionId).toBe("previous-session");
    expect(result.sessionInfo).toBeUndefined();
    expect(params.present).not.toHaveBeenCalled();
  });

  it("joins private ownership reads before reporting a metadata failure", async () => {
    const entry = { sessionId: "private-session", incognito: true };
    const key = "agent:main:dashboard:private";
    params.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "main",
      canonicalKey: key,
      storePath: "/tmp/private.sqlite",
      store: { [key]: entry },
      entry,
    });
    const metadata = Promise.withResolvers<Awaited<ReturnType<typeof params.readAcpMetadata>>>();
    const ownership =
      Promise.withResolvers<
        Awaited<ReturnType<typeof sessionRuntimeOwnership.readSessionRuntimeOwnershipAsync>>
      >();
    params.readAcpMetadata.mockReturnValueOnce(metadata.promise);
    const readOwnership = vi
      .spyOn(sessionRuntimeOwnership, "readSessionRuntimeOwnershipAsync")
      .mockReturnValueOnce(ownership.promise);
    const backend = params.createBackend();
    backend.start();
    let settled = false;
    const reading = backend.loadHistory({ sessionKey: key }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    const failure = new Error("private metadata retired");
    try {
      await vi.waitFor(() => expect(params.readAcpMetadata).toHaveBeenCalled());
      await vi.waitFor(() => expect(readOwnership).toHaveBeenCalled());
      metadata.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(params.buildSessionRow).not.toHaveBeenCalled();
      ownership.resolve(undefined);
      expect(await reading).toBe(failure);
      expect(params.present).not.toHaveBeenCalled();
    } finally {
      metadata.resolve([null]);
      ownership.resolve(undefined);
      await reading;
      readOwnership.mockRestore();
      await backend.stop();
    }
  });

  it("preserves incognito history metadata without adding the row to the resident projection", async () => {
    const entry = { sessionId: "private-session", incognito: true };
    const key = "agent:main:dashboard:private";
    params.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "main",
      canonicalKey: key,
      storePath: "/tmp/private.sqlite",
      store: { [key]: entry },
      entry,
    });
    const backend = params.createBackend();
    backend.start();
    try {
      await expect(backend.loadHistory({ sessionKey: key })).resolves.toMatchObject({
        sessionId: entry.sessionId,
        sessionInfo: { key, sessionId: entry.sessionId },
      });
      expect(params.buildSessionRow).toHaveBeenCalledWith(
        expect.objectContaining({
          key,
          entry,
          storePath: "/tmp/private.sqlite",
          lightweightListRow: true,
        }),
      );
      expect(params.present).not.toHaveBeenCalled();
    } finally {
      await backend.stop();
    }
  });
}
