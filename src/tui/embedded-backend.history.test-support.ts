import { expect, it, vi, type Mock } from "vitest";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";

export function registerEmbeddedHistoryProjectionTests(params: {
  createBackend: () => EmbeddedTuiBackend;
  loadSessionEntry: Mock;
  describe: Mock;
  present: Mock;
  withPreparedExactRows: Mock;
  buildSessionRow: Mock;
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

  it("validates and presents history metadata within its prepared read frame", async () => {
    const entry = { sessionId: "captured-session", lifecycleRevision: "captured-revision" };
    const target = { key: "global", agentId: "work", storePath: "/tmp/physical.sqlite" };
    params.loadSessionEntry.mockReturnValue({
      cfg: {},
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
      target,
    };
    const describe = vi.fn(() => row);
    const present = vi.fn((current: typeof row) => {
      expect(active, "history metadata must be presented before the read expires").toBe(true);
      expect(current).toBe(row);
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
      sessionInfo: { key: target.key, sessionId: entry.sessionId },
    });
    expect(describe).toHaveBeenCalledExactlyOnceWith(target);
    expect(params.present).not.toHaveBeenCalled();
    expect(params.buildSessionRow).not.toHaveBeenCalled();
    expect(active).toBe(false);
  });

  it.each([
    { sessionId: "replacement-session", lifecycleRevision: "previous-revision" },
    { sessionId: "previous-session", lifecycleRevision: "replacement-revision" },
  ])("does not attach a replacement session row to captured history: %j", async (currentEntry) => {
    params.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "main",
      canonicalKey: "agent:main:main",
      storePath: "/tmp/main.sqlite",
      entry: { sessionId: "previous-session", lifecycleRevision: "previous-revision" },
    });
    params.describe.mockReturnValue({
      entry: currentEntry,
      target: { key: "agent:main:main" },
    });
    expect(await loadHistory({ sessionKey: "agent:main:main" })).toMatchObject({
      sessionId: "previous-session",
      sessionInfo: undefined,
    });
    expect(params.present).not.toHaveBeenCalled();
    expect(params.buildSessionRow).not.toHaveBeenCalled();
  });

  it("loads history verbose level from the session agent's own verboseDefault", async () => {
    params.loadSessionEntry.mockReturnValue({
      cfg: {
        agents: {
          defaults: { verboseDefault: "off" },
          entries: { main: {}, ops: { verboseDefault: "full" } },
        },
      },
      agentId: "ops",
      canonicalKey: "agent:ops:main",
      entry: {},
    });
    expect((await loadHistory({ sessionKey: "agent:ops:main" })).verboseLevel).toBe("full");
  });
}
