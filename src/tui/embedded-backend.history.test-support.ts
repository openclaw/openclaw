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
}
