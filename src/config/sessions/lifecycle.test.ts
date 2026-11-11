import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { hasTerminalMainSessionTranscriptNewerThanRegistryAsync } from "./lifecycle-read.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-lifecycle-");

let storePath: string;

beforeEach(() => {
  storePath = path.join(sessionDirs.make(), "agents", "main", "sessions", "sessions.json");
});

const scopeFor = (sessionKey: string) => ({ agentId: "main", sessionKey, storePath });

async function createEntry(
  status?: SessionEntry["status"],
  params: Partial<Pick<SessionEntry, "endedAt" | "updatedAt">> & {
    sessionKey?: string;
  } = {},
) {
  const { sessionKey = "agent:main:main", ...overrides } = params;
  const metadata = {
    updatedAt: Date.now() - 10_000,
    ...overrides,
    ...(status ? { status } : {}),
  };
  const sessionId = `session-${status ?? "ended"}-${sessionKey.replaceAll(":", "-")}`;
  const sessionEntry = {
    ...metadata,
    sessionId,
  };
  await upsertSessionEntryCore(scopeFor(sessionKey), sessionEntry);
  await appendTranscriptEvent(
    { ...scopeFor(sessionKey), sessionId },
    { type: "custom", timestamp: "1970-01-01T00:00:00.001Z" },
  );
  return {
    entry: { ...loadEntry(sessionKey), ...metadata },
    sessionKey,
  };
}

function loadEntry(sessionKey: string): SessionEntry {
  return expectDefined(loadSessionEntry(scopeFor(sessionKey)), "session entry");
}

const check = (entry: SessionEntry, sessionKey: string) =>
  hasTerminalMainSessionTranscriptNewerThanRegistryAsync({ ...scopeFor(sessionKey), entry });

it("uses the physical SQLite mutation watermark instead of event timestamps", async () => {
  const { entry, sessionKey } = await createEntry("killed");
  const sql = observeHostDataSql();
  using _ = { [Symbol.dispose]: () => sql.restore() };
  expect(await check(entry, sessionKey)).toBe(true);
  expect(sql.queries).toEqual([]);
});

it.each(["done", "failed"] as const)("uses the correct %s transcript freshness", async (kind) => {
  const { entry, sessionKey } = await createEntry(kind);
  expect(await check(entry, sessionKey)).toBe(false);
});

it("keeps a yielded main session reusable after a child transcript admission", async () => {
  const { entry, sessionKey } = await createEntry(undefined, { endedAt: Date.now() - 20_000 });

  expect(await check(entry, sessionKey)).toBe(false);
});

it("does not rotate after a same-millisecond registry write observes the mutation", async () => {
  const now = 1_700_000_000_000;
  const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
  const { entry, sessionKey } = await createEntry("killed", { updatedAt: now });
  expect(await check(entry, sessionKey)).toBe(true);

  await upsertSessionEntryCore(scopeFor(sessionKey), entry);
  const refreshed = loadEntry(sessionKey);
  dateNow.mockRestore();

  expect(await check(refreshed, sessionKey)).toBe(false);
});

it("does not rotate non-main sessions or rows newer than the transcript", async () => {
  const nonMain = await createEntry("killed", { sessionKey: "agent:main:other" });
  const newerRegistry = await createEntry("timeout", { updatedAt: Date.now() + 10_000 });
  await upsertSessionEntryCore(scopeFor(newerRegistry.sessionKey), newerRegistry.entry);
  const refreshedRegistry = loadEntry(newerRegistry.sessionKey);

  expect(await check(nonMain.entry, nonMain.sessionKey)).toBe(false);
  expect(await check(refreshedRegistry, newerRegistry.sessionKey)).toBe(false);
});
