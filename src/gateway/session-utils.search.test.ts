import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

const cfg = { session: { mainKey: "main" }, agents: { entries: { main: {} } } };
let projection: ReturnType<typeof createSessionRowProjectionFixture> | undefined;
beforeEach(() => setRuntimeConfigSnapshot(cfg));
afterEach(() => {
  projection?.dispose();
  projection = undefined;
  clearRuntimeConfigSnapshot();
});

function entry(id: string, updatedAt: number, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: id, updatedAt, ...fields };
}

function selection(store: Record<string, SessionEntry>, now = Date.now()) {
  const owner = createSessionRowProjectionFixture({ cfg, store, agentId: "main" });
  projection = owner;
  return (opts: Parameters<typeof prepareSessionRowSelection>[1]) =>
    filterAndSortSessionEntries({ ...prepareSessionRowSelection(owner, opts), now }).map(
      ([key]) => key,
    );
}

test("search matches title punctuation and spacing before selecting the result window", () => {
  const key = "agent:main:communication";
  const select = selection({
    [key]: entry("communication", 1, { displayName: "Per-session communication controls in UI" }),
    "agent:main:unrelated": entry("unrelated", 2, { displayName: "Unrelated discussion" }),
  });
  const search = (query: string) => select({ search: query, limit: 1 });
  for (const query of [
    "per session communi",
    "per-session communication controls",
    "PER—SESSION   COMMUNICATION",
    key,
  ]) {
    expect(search(query), query).toEqual([key]);
  }
  for (const query of ["per session missing", "---", "agent main communication"]) {
    expect(search(query), query).toEqual([]);
  }
});

test.each(["München", "한국어"])("search finds both canonical forms of %s", (title) => {
  const decomposedTitle = title.normalize("NFD");
  const select = selection({
    "agent:main:composed": entry("composed", 1, { displayName: title }),
    "agent:main:decomposed": entry("decomposed", 2, { displayName: decomposedTitle }),
    "agent:main:unrelated": entry("unrelated", 3, { displayName: "Unrelated discussion" }),
  });
  for (const search of [title, decomposedTitle]) {
    expect(select({ search, limit: 2 }), search).toEqual([
      "agent:main:decomposed",
      "agent:main:composed",
    ]);
  }
});

test("ranks by real interaction without heartbeat or cron noise", () => {
  const now = Date.now();
  const select = selection(
    {
      "agent:main:main": entry("main", now - 10_000, { lastInteractionAt: now - 1_000 }),
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
    },
    now,
  );
  expect(select({ requireLastInteraction: true, sortBy: "lastInteractionAt" })).toEqual([
    "agent:main:main",
    "agent:main:heartbeat-noise",
  ]);
});
