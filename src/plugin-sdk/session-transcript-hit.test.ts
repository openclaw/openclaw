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
] as const)(
  "filters incognito rows from the %s plugin cross-session view",
  async (_label, load) => {
    const snapshot = {
      storePath: "(multiple)",
      store: {
        "agent:main:dashboard:visible": { sessionId: "visible", updatedAt: 1 },
        "agent:main:dashboard:incognito-private": {
          incognito: true,
          sessionId: "private",
          updatedAt: 2,
        },
      },
    };
    loadGatewaySessionStore.mockReturnValue(snapshot);
    loadGatewaySessionStoreAsync.mockResolvedValue(snapshot);

    expect((await load({})).store).toEqual({
      "agent:main:dashboard:visible": { sessionId: "visible", updatedAt: 1 },
    });
  },
);

it("extracts builtin live and archived transcript identities", () => {
  expect(extractStem("sessions/abc-uuid.jsonl")).toBe("abc-uuid");
  expect(
    extractIdentity("sessions/main/deleted-uuid.jsonl.deleted.2026-02-16T22-27-33.000Z"),
  ).toEqual({
    stem: "deleted-uuid",
    ownerAgentId: "main",
    archived: true,
  });
});

it("rejects paths outside the builtin transcript format", () => {
  expect(extractStem("sessions/note.md")).toBeNull();
  expect(extractStem("sessions/weird.jsonl.backup.2026-01-01.zst")).toBeNull();
});

const baseEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "stem-a",
  updatedAt: 1,
  ...overrides,
});

it("returns every non-incognito key with an exact session identity", () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:s1": baseEntry(),
    "agent:peer:s2": baseEntry(),
    "agent:main:dashboard:incognito-private": baseEntry({ incognito: true }),
  };

  expect(resolveStemKeys({ store, stem: "stem-a" }).toSorted()).toEqual([
    "agent:main:s1",
    "agent:peer:s2",
  ]);
});

it("falls back to archived owner metadata after the live row is removed", () => {
  expect(
    resolveStemKeys({
      store: {},
      stem: "deleted-stem",
      archivedOwnerAgentId: "main",
    }),
  ).toEqual(["agent:main:deleted-stem"]);
});

it("exports storage-neutral memory hit key helpers from the legacy hit subpath", () => {
  const key = formatKey({
    agentId: "main",
    sessionId: "session:legacy",
  });
  const store: Record<string, SessionEntry> = {
    "agent:main:discord:direct:42": {
      sessionFile: "/tmp/not-the-identity.jsonl",
      sessionId: "session:legacy",
      updatedAt: 10,
    },
  };

  expect(key).toBe("transcript:main:session%3Alegacy");
  expect(parseKey(key)).toMatchObject({
    agentId: "main",
    sessionId: "session:legacy",
  });
  expect(resolveHitKeys({ key, store })).toEqual(["agent:main:discord:direct:42"]);
});
