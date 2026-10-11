import { describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { filterAndSortSessionEntries, prepareSessionRowSelection } from "./session-utils-list.js";

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

const baseCfg = {
  session: { mainKey: "main" },
  agents: { entries: { main: {} } },
} as OpenClawConfig;

function selectSessionKeys(params: {
  opts: Parameters<typeof filterAndSortSessionEntries>[0]["opts"];
  cfg?: OpenClawConfig;
  store: Record<string, SessionEntry>;
  now?: number;
}): string[] {
  const now = params.now ?? Date.now();
  const store = params.store;
  const projection = createSessionRowProjectionFixture({
    cfg: params.cfg ?? baseCfg,
    store,
    agentId: "main",
  });
  try {
    return filterAndSortSessionEntries({
      ...prepareSessionRowSelection(projection, params.opts),
      now,
    }).map(([key]) => key);
  } finally {
    projection.dispose();
  }
}

describe("filterAndSortSessionEntries search", () => {
  test("matches title punctuation and spacing before selecting the result window", () => {
    const key = "agent:main:communication";
    const store: Record<string, SessionEntry> = {
      [key]: {
        sessionId: "communication",
        updatedAt: 1,
        displayName: "Per-session communication controls in UI",
      },
      "agent:main:unrelated": {
        sessionId: "unrelated",
        updatedAt: 2,
        displayName: "Unrelated discussion",
      },
    };
    const projection = createSessionRowProjectionFixture({ cfg: baseCfg, store });
    const search = (query: string) =>
      filterAndSortSessionEntries(
        prepareSessionRowSelection(projection, { search: query, limit: 1 }),
      ).map(([selected]) => selected);
    try {
      for (const query of [
        "per session communi",
        "per-session communication controls",
        "PER—SESSION   COMMUNICATION",
      ]) {
        expect(search(query), query).toEqual([key]);
      }
      expect(search("per session missing")).toEqual([]);
      expect(search("---")).toEqual([]);
      expect(search("agent main communication")).toEqual([]);
      expect(search(key)).toEqual([key]);
    } finally {
      projection.dispose();
    }
  });

  test("ranks by real interaction without heartbeat or cron noise", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "main",
        updatedAt: now - 10_000,
        lastInteractionAt: now - 1_000,
      } as SessionEntry,
      "agent:main:heartbeat-noise": {
        sessionId: "heartbeat-noise",
        updatedAt: now,
        lastInteractionAt: now - 5_000,
        pinnedAt: now,
      } as SessionEntry,
      "agent:main:background-only": {
        sessionId: "background-only",
        updatedAt: now + 1_000,
      } as SessionEntry,
      "agent:main:main:heartbeat": {
        sessionId: "isolated-heartbeat",
        updatedAt: now + 3_000,
        lastInteractionAt: now + 3_000,
        heartbeatIsolatedBaseSessionKey: "agent:main:main",
      } as SessionEntry,
      "agent:main:cron:job-1:run:run-abc": {
        sessionId: "run-abc",
        updatedAt: now + 2_000,
        lastInteractionAt: now + 2_000,
      } as SessionEntry,
    };

    expect(
      selectSessionKeys({
        store,
        opts: { requireLastInteraction: true, sortBy: "lastInteractionAt" },
        now,
      }),
    ).toEqual(["agent:main:main", "agent:main:heartbeat-noise"]);
  });
});
