import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import * as userProfileList from "../../state/user-profile-list.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { createSessionCatalogRequestEntrySnapshot } from "./session-catalog-entry-snapshot.js";
import { readAuthorizedSessionCatalog } from "./session-catalog-read.js";
import {
  catalogHost,
  catalogProvider,
  catalogSession,
} from "./session-catalog.fixtures.test-support.js";

let projection: ReturnType<typeof createSessionRowProjectionFixture>;

const snapshot = () =>
  createSessionCatalogRequestEntrySnapshot({ cfg: {}, fallbackAgentId: "main", projection });

function setEntries(entries: Record<string, Partial<SessionEntry>>) {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    projection.setEntry(sessionKey, { sessionId: sessionKey, updatedAt: 1, ...entry });
  }
}

describe("session catalog entry snapshots", () => {
  afterEach(() => {
    projection.dispose();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(userProfileList, "hasMultipleResidentSessionSharingIdentities").mockReturnValue(false);
    projection = createSessionRowProjectionFixture({ cfg: {}, store: {} });
  });

  it("resolves catalog senders against current profiles without attributing unknown turns", async () => {
    vi.spyOn(userProfileList, "getResidentUserProfileDisplay").mockImplementation((id) => {
      if (id !== "merged-profile") {
        throw new Error("unknown profile");
      }
      return { id: "current-profile", displayName: "Taylor", avatarRevision: "2", hasAvatar: true };
    });
    const message = (text: string, id?: string, label?: string) => ({
      type: "userMessage" as const,
      text,
      ...(id
        ? { sender: { identity: { type: "profile" as const, id }, ...(label ? { label } : {}) } }
        : {}),
    });
    const items = [
      message("Unknown author"),
      message("Known author", "merged-profile", "Stale"),
      message("Deleted author", "deleted-profile"),
    ];
    const catalog = catalogProvider("external", {
      read: async ({ hostId, threadId }) => ({ hostId, threadId, items, nextCursor: "older" }),
    });
    const result = await readAuthorizedSessionCatalog({
      request: { catalogId: "external", hostId: "gateway", threadId: "shared" },
      provider: catalog,
      agentId: "main",
      allowProcessHomeFallback: false,
      client: null,
      context: { getRuntimeConfig: () => ({}) },
    });
    expect(result).toEqual({
      ok: true,
      page: {
        hostId: "gateway",
        threadId: "shared",
        nextCursor: "older",
        items: [
          items[0],
          {
            ...items[1],
            sender: {
              identity: { type: "profile", id: "current-profile" },
              label: "Taylor",
              avatarUrl: "/api/users/current-profile/avatar?v=2",
            },
          },
          items[2],
        ],
      },
    });
  });

  it.each([
    [" BLUE ", "blue"],
    ["invalid", undefined],
    [undefined, undefined],
  ])("projects provider color %s to its canonical wire value", (color, expected) => {
    const host = snapshot().projectHostSessions(
      catalogHost({ sessions: [catalogSession("color-fixture", { color })] }),
      new Map(),
    );
    expect(host.sessions[0]?.color).toBe(expected);
  });

  it("reuses frozen planning entries until rows or configuration change", async () => {
    const key = "agent:main:lazy";
    setEntries({ [key]: { label: "Before" } });
    let cfg = {};
    const capture = () => {
      const value = createSessionCatalogRequestEntrySnapshot({
        cfg,
        fallbackAgentId: "main",
        projection,
      });
      value.freeze();
      return value;
    };
    const first = capture();
    const catalog = first.sessionEntries.entriesForCatalog!();
    expect(first.entryForSession(key)?.label).toBe("Before");
    const second = capture();
    expect(second.sessionEntries.entriesForCatalog!()).toBe(catalog);
    expect(first.sessionEntries.revision).toBeDefined();
    expect(second.sessionEntries.revision).toBe(first.sessionEntries.revision);

    await Promise.resolve();
    setEntries({ [key]: { label: "After" } });
    const entries = first.sessionEntries.entriesForAgent("MAIN");
    expect(entries).toEqual([
      { sessionKey: key, entry: expect.objectContaining({ label: "Before" }) },
    ]);
    expect(second.sessionEntries.entriesForAgent("main")).toBe(entries);
    for (const value of [entries, entries[0], catalog, catalog[0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(first.sessionEntries.entriesForAgent("unknown")).toEqual([]);
    const current = capture();
    expect(current.entryForSession(key)?.label).toBe("After");
    expect(current.sessionEntries.revision).not.toBe(first.sessionEntries.revision);
    expect(capture().sessionEntries.revision).toBe(current.sessionEntries.revision);
    cfg = {};
    const reconfigured = capture();
    expect(reconfigured.sessionEntries.revision).not.toBe(current.sessionEntries.revision);
    expect(reconfigured.entryForSession(key)?.label).toBe("After");
  });
});
