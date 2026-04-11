import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  detectStartupStuckSessionReason,
  runStartupStuckSessionReplay,
  selectStartupReplayCandidates,
  shouldSkipStartupReplaySession,
  type StartupStuckSessionReason,
} from "./server-startup-stuck-session-replay.js";

describe("detectStartupStuckSessionReason", () => {
  it("flags sessions when the last meaningful message is a user turn", () => {
    const reason = detectStartupStuckSessionReason([
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Please continue" },
      { role: "tool", content: "tool output" },
    ]);
    expect(reason).toBe("pending-user-turn");
  });

  it("flags sessions when the last assistant message has no visible text and no tool calls", () => {
    const reason = detectStartupStuckSessionReason([
      { role: "user", content: "Do work" },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ]);
    expect(reason).toBe("assistant-empty-no-tools");
  });

  it("ignores assistant entries that include tool calls", () => {
    const reason = detectStartupStuckSessionReason([
      { role: "user", content: "Do work" },
      {
        role: "assistant",
        content: [{ type: "tool_call", name: "search" }],
      },
    ]);
    expect(reason).toBeNull();
  });
});

describe("startup replay selection", () => {
  it("sorts by newest first and applies the configured cap", () => {
    const selected = selectStartupReplayCandidates(
      [
        {
          key: "s1",
          sessionId: "s1",
          updatedAt: 10,
          reason: "pending-user-turn",
          storePath: "(test)",
        },
        {
          key: "s3",
          sessionId: "s3",
          updatedAt: 30,
          reason: "assistant-empty-no-tools",
          storePath: "(test)",
        },
        {
          key: "s2",
          sessionId: "s2",
          updatedAt: 20,
          reason: "pending-user-turn",
          storePath: "(test)",
        },
      ],
      2,
    );
    expect(selected.map((candidate) => candidate.key)).toEqual(["s3", "s2"]);
  });

  it("skips global, unknown, cron-run, and internal-channel sessions", () => {
    const baseEntry = { sessionId: "s", updatedAt: 1 } as SessionEntry;
    expect(shouldSkipStartupReplaySession({ key: "global", entry: baseEntry })).toBe(true);
    expect(shouldSkipStartupReplaySession({ key: "unknown", entry: baseEntry })).toBe(true);
    expect(
      shouldSkipStartupReplaySession({
        key: "agent:main:cron:nightly:run:abc",
        entry: baseEntry,
      }),
    ).toBe(true);
    expect(
      shouldSkipStartupReplaySession({
        key: "agent:main:internal:dev",
        entry: { ...baseEntry, channel: "internal" },
      }),
    ).toBe(true);
    expect(
      shouldSkipStartupReplaySession({
        key: "agent:main:webchat:user1",
        entry: { ...baseEntry, channel: "webchat" },
      }),
    ).toBe(true);
  });
});

describe("runStartupStuckSessionReplay", () => {
  it("replays newest stuck sessions and logs startup summary", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:telegram:group:-1001:topic:done": {
        sessionId: "done",
        updatedAt: 50,
        channel: "telegram",
      },
      "agent:main:telegram:group:-1001:topic:newest": {
        sessionId: "newest",
        updatedAt: 300,
        channel: "telegram",
      },
      "agent:main:telegram:group:-1001:topic:older": {
        sessionId: "older",
        updatedAt: 200,
        channel: "telegram",
      },
      "agent:main:internal:skip": {
        sessionId: "skip",
        updatedAt: 400,
        channel: "internal",
      },
    };
    const reasonsBySessionId: Record<string, StartupStuckSessionReason | null> = {
      done: null,
      newest: "pending-user-turn",
      older: "assistant-empty-no-tools",
      skip: "pending-user-turn",
    };

    const sent: string[] = [];
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    await runStartupStuckSessionReplay({
      cfg: {} as never,
      context: {} as never,
      maxRecoveries: 2,
      deps: {
        loadCombinedStore: () => ({ storePath: "(test)", store }),
        resolveStoreTarget: () => ({
          agentId: "main",
          storePath: "(test)",
          canonicalKey: "",
          storeKeys: [],
        }),
        readMessages: (sessionId) => {
          const reason = reasonsBySessionId[sessionId];
          if (reason === "pending-user-turn") {
            return [{ role: "user", content: "pending turn" }];
          }
          if (reason === "assistant-empty-no-tools") {
            return [{ role: "assistant", content: [{ type: "text", text: "" }] }];
          }
          return [{ role: "assistant", content: "already answered" }];
        },
        sendMessage: async ({ key }) => {
          sent.push(key);
          if (key.endsWith(":older")) {
            throw new Error("send failed");
          }
        },
      },
      log,
    });

    expect(sent).toEqual([
      "agent:main:telegram:group:-1001:topic:newest",
      "agent:main:telegram:group:-1001:topic:older",
    ]);
    const summaryLine =
      log.info.mock.calls.find((c: string[]) => c[0]?.includes("summary"))?.[0] ?? "";
    expect(summaryLine).toContain("scanned=3");
    expect(summaryLine).toContain("candidates=2");
    expect(summaryLine).toContain("replayed=1");
    expect(summaryLine).toContain("skipped_stale=0");
    expect(summaryLine).toContain("failed=1");
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0]?.[0]).toContain("startup stuck-session replay failed");
  });

  it("skips candidates whose transcript changed between scan and send (stale race)", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:telegram:group:-1001:topic:racing": {
        sessionId: "racing",
        updatedAt: 100,
        channel: "telegram",
      },
    };

    let readCount = 0;
    const sent: string[] = [];
    const log = { info: vi.fn(), warn: vi.fn() };

    await runStartupStuckSessionReplay({
      cfg: {} as never,
      context: {} as never,
      maxRecoveries: 5,
      deps: {
        loadCombinedStore: () => ({ storePath: "(test)", store }),
        resolveStoreTarget: () => ({
          agentId: "main",
          storePath: "(test)",
          canonicalKey: "",
          storeKeys: [],
        }),
        readMessages: () => {
          readCount += 1;
          // First read (scan): stuck. Second read (re-verify): no longer stuck.
          if (readCount <= 1) {
            return [{ role: "user", content: "pending turn" }];
          }
          return [
            { role: "user", content: "pending turn" },
            { role: "assistant", content: "I replied while you were scanning" },
          ];
        },
        sendMessage: async ({ key }) => {
          sent.push(key);
        },
      },
      log,
    });

    expect(sent).toEqual([]);
    const summaryLine =
      log.info.mock.calls.find((c: string[]) => c[0]?.includes("summary"))?.[0] ?? "";
    expect(summaryLine).toContain("skipped_stale=1");
    expect(summaryLine).toContain("replayed=0");
  });
});
