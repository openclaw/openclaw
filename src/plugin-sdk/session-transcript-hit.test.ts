import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  extractTranscriptIdentityFromSessionsMemoryHit as extractIdentity,
  extractTranscriptStemFromSessionsMemoryHit as extractStem,
  formatSessionTranscriptMemoryHitKey as formatKey,
  loadCombinedSessionStoreForGateway,
  loadCombinedSessionStoreForGatewayAsync,
  parseSessionTranscriptMemoryHitKey as parseKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys as resolveHitKeys,
  resolveTranscriptStemToSessionKeys as resolveStemKeys,
} from "./session-transcript-hit.js";

const entry = (sessionId = "stem-a", overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId,
  updatedAt: 1,
  ...overrides,
});
const { loadGatewaySessionStore, loadGatewaySessionStoreAsync } = vi.hoisted(() => ({
  loadGatewaySessionStore: vi.fn(),
  loadGatewaySessionStoreAsync: vi.fn(),
}));
// mock-isolation: SDK projection tests supply synthetic snapshots without loading database owners.
vi.mock("../config/sessions/combined-store-gateway.native.js", () => ({
  loadCombinedSessionStoreForGatewayCore: loadGatewaySessionStore,
}));
// mock-isolation: SDK projection tests supply synthetic snapshots without loading database owners.
vi.mock("../config/sessions/combined-store-gateway-read.js", () => ({
  loadCombinedSessionStoreForGatewayCoreAsync: loadGatewaySessionStoreAsync,
}));

it.each([
  ["synchronous compatibility", loadCombinedSessionStoreForGateway],
  ["async", loadCombinedSessionStoreForGatewayAsync],
] as const)("filters incognito rows (%s)", async (_label, load) => {
  const visible = entry("visible");
  const snapshot = {
    storePath: "(multiple)",
    store: {
      "agent:main:dashboard:visible": visible,
      "agent:main:dashboard:incognito-private": entry("private", { incognito: true }),
    },
  };
  loadGatewaySessionStore.mockReturnValue(snapshot);
  loadGatewaySessionStoreAsync.mockResolvedValue(snapshot);

  expect((await load({})).store).toEqual({ "agent:main:dashboard:visible": visible });
});

it("extracts builtin live and archived transcript identities", () => {
  expect(extractStem("sessions/abc-uuid.jsonl")).toBe("abc-uuid");
  const archived = "sessions/main/deleted-uuid.jsonl.deleted.2026-02-16T22-27-33.000Z";
  const expected = { stem: "deleted-uuid", ownerAgentId: "main", archived: true };
  expect(extractIdentity(archived)).toEqual(expected);
});

it("rejects paths outside the builtin transcript format", () => {
  expect(extractStem("sessions/note.md")).toBeNull();
  expect(extractStem("sessions/weird.jsonl.backup.2026-01-01.zst")).toBeNull();
});

it("returns every non-incognito key with an exact session identity", () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:s1": entry(),
    "agent:peer:s2": entry(),
    "agent:main:dashboard:incognito-private": entry("stem-a", { incognito: true }),
  };

  expect(resolveStemKeys({ store, stem: "stem-a" }).toSorted()).toEqual([
    "agent:main:s1",
    "agent:peer:s2",
  ]);
});

it("falls back to archived owner metadata after the live row is removed", () => {
  const keys = resolveStemKeys({ store: {}, stem: "deleted-stem", archivedOwnerAgentId: "main" });
  expect(keys).toEqual(["agent:main:deleted-stem"]);
});

it.each([
  ["session:legacy", "session%3Alegacy"],
  ["my-plugin:task/1", "my-plugin%3Atask%2F1"],
])("resolves identity %s", (sessionId, encoded) => {
  const key = formatKey({ agentId: "main", sessionId });
  const store: Record<string, SessionEntry> = {
    "agent:main:discord:direct:42": entry(sessionId, {
      sessionFile: "/tmp/other.jsonl",
      updatedAt: 10,
    }),
  };

  expect(key).toBe(`transcript:main:${encoded}`);
  expect(parseKey(key)).toMatchObject({ agentId: "main", sessionId });
  expect(resolveHitKeys({ key, store })).toEqual(["agent:main:discord:direct:42"]);
});
