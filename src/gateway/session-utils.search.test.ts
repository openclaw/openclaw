import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
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

function entry(
  sessionId: string,
  updatedAt: number,
  fields: Partial<SessionEntry> = {},
): SessionEntry {
  return { sessionId, updatedAt, ...fields };
}

type Select = (
  opts: Parameters<typeof filterAndSortSessionEntries>[0]["opts"],
  now?: number,
) => string[];

function withSelection(store: Record<string, SessionEntry>, consume: (select: Select) => void) {
  const projection = createSessionRowProjectionFixture({ cfg: baseCfg, store, agentId: "main" });
  try {
    consume((opts, now = Date.now()) =>
      filterAndSortSessionEntries({
        ...prepareSessionRowSelection(projection, opts),
        now,
      }).map(([key]) => key),
    );
  } finally {
    projection.dispose();
  }
}

describe("filterAndSortSessionEntries search", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot(baseCfg);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  test("matches title punctuation and spacing before selecting the result window", () => {
    const key = "agent:main:communication";
    const store: Record<string, SessionEntry> = {
      [key]: entry("communication", 1, {
        displayName: "Per-session communication controls in UI",
      }),
      "agent:main:unrelated": entry("unrelated", 2, {
        displayName: "Unrelated discussion",
      }),
    };
    withSelection(store, (select) => {
      const search = (query: string) => select({ search: query, limit: 1 });
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
    });
  });

  test("ranks by real interaction without heartbeat or cron noise", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": entry("main", now - 10_000, {
        lastInteractionAt: now - 1_000,
      }),
      "agent:main:heartbeat-noise": entry("heartbeat-noise", now, {
        lastInteractionAt: now - 5_000,
        pinnedAt: now,
      }),
      "agent:main:background-only": entry("background-only", now + 1_000),
      "agent:main:main:heartbeat": entry("isolated-heartbeat", now + 3_000, {
        lastInteractionAt: now + 3_000,
        heartbeatIsolatedBaseSessionKey: "agent:main:main",
      }),
      "agent:main:cron:job-1:run:run-abc": entry("run-abc", now + 2_000, {
        lastInteractionAt: now + 2_000,
      }),
    };

    withSelection(store, (select) => {
      expect(select({ requireLastInteraction: true, sortBy: "lastInteractionAt" }, now)).toEqual([
        "agent:main:main",
        "agent:main:heartbeat-noise",
      ]);
    });
  });
});
