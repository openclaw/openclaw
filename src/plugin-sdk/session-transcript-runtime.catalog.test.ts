import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  appendTranscriptMessages,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  getSessionColdStorageStatus,
  runSessionColdStorageMaintenance,
} from "../config/sessions/session-cold-storage.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { reconcileSessionTranscriptIndexes } from "../config/sessions/session-transcript-reconcile.js";
import {
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  ensureProfileForEmail,
  getUserProfileDisplay,
  linkEmail,
  setDisplayName,
  syncGitHubIdentity,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createSessionCatalogGitHubLinker,
  createSessionCatalogSourceActorProjector,
  readSessionTranscriptCatalogPage,
  readSessionTranscriptCatalogTitle,
} from "./session-transcript-runtime.js";

const source = { pluginId: "session-share", sourceDomain: "source-node" };
const scope = { agentId: "main", sessionKey: "agent:main:shared", sessionId: "shared-session" };
const read = (limit: number, cursor?: string) =>
  readSessionTranscriptCatalogPage({ ...scope, ...source, limit, cursor });

async function seed(messages: unknown[]) {
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (const [index, message] of messages.entries()) {
    await appendTranscriptMessage(scope, {
      eventId: `message-${index}`,
      message,
      now: 1000 + index,
    });
  }
}

describe("native transcript catalog SDK", () => {
  it("keeps cold transcript listings available without restoring source storage", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([{ role: "user", content: "Archived question" }]);
      const config = {
        agents: { entries: { main: {} } },
        session: { maintenance: { coldStorage: { enabled: true, afterDays: 1 } } },
      };
      const inactiveNow = Date.now() + 2 * 24 * 60 * 60 * 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(inactiveNow);
      try {
        expect(await runSessionColdStorageMaintenance({ config })).toMatchObject({
          archivedTranscripts: 1,
        });
      } finally {
        clock.mockRestore();
      }
      const entry = loadSessionEntryReadOnly(scope);
      if (!entry) {
        throw new Error("missing fixture entry");
      }
      expect(readSessionTranscriptCatalogTitle({ ...scope, entry })).toBeUndefined();
      expect(
        readSessionTranscriptCatalogTitle({
          ...scope,
          entry: { ...entry, label: "Named archive" },
        }),
      ).toBe("Named archive");
      await expect(read(1)).rejects.toThrow("cold storage");
      expect(await getSessionColdStorageStatus(config)).toEqual([
        expect.objectContaining({ hotTranscripts: 0, coldTranscripts: 1 }),
      ]);
    });
  });

  it("bounds raw title probes and reports oversized transcript entries without skipping them", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([
        { role: "user", content: "x".repeat(8 * 1024 * 1024) },
        { role: "assistant", content: "Small final answer" },
      ]);
      const entry = loadSessionEntryReadOnly(scope);
      if (!entry) {
        throw new Error("missing fixture entry");
      }
      expect.soft(readSessionTranscriptCatalogTitle({ ...scope, entry })).toBeUndefined();
      const first = await read(1);
      expect(first.items).toEqual([
        expect.objectContaining({ type: "agentMessage", text: "Small final answer" }),
      ]);
      expect(first.nextCursor).toBeDefined();
      await expect(read(1, first.nextCursor)).rejects.toThrow("too large to share");
      await appendTranscriptMessage(scope, {
        eventId: "oversized-tail",
        message: { role: "assistant", content: "y".repeat(8 * 1024 * 1024) },
      });
      await expect(read(1)).rejects.toThrow("too large to share");
    });
  });

  it("pages only user and assistant text newest-first without opening a writer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([
        { role: "user", content: "Visible question" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "First answer part" },
            { type: "thinking", thinking: "Reasoning" },
            { type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } },
            { type: "output_text", text: "Second answer part" },
            { type: "tool_result", content: "Embedded tool result" },
            { type: "reasoning", text: "More reasoning" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "image", text: "Image metadata" },
            { type: "text", text: " \n " },
            { type: "text", text: "NO_REPLY" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: [{ type: "text", text: "Tool result" }],
        },
        { role: "assistant", content: [{ type: "text", text: "Answer" }] },
        { role: "tool", content: "Tool role" },
        { role: "tool_result", content: [{ type: "text", text: "Other tool role" }] },
        { role: "system", content: "System instructions" },
        { role: "custom", content: [{ type: "text", text: "Unknown role" }] },
        { role: "user", content: [{ type: "tool_result", content: "User tool result" }] },
        { role: "assistant", content: "   " },
        { role: "assistant", content: "NO_REPLY" },
      ]);
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const before = fs.readFileSync(databasePath);
      const first = await read(2);
      expect(first.items.map((item) => [item.type, item.text])).toEqual([
        ["agentMessage", "Answer"],
        ["agentMessage", "Second answer part"],
      ]);
      const second = await read(1, first.nextCursor);
      expect(second.items).toMatchObject([{ type: "agentMessage", text: "First answer part" }]);
      const third = await read(2, second.nextCursor);
      expect(third.items.map((item) => [item.type, item.text])).toEqual([
        ["userMessage", "Visible question"],
      ]);
      expect(third.nextCursor).toBeUndefined();
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
      expect(fs.readFileSync(databasePath)).toEqual(before);
    });
  });

  it("continues across a page containing only hidden tool activity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([{ role: "user", content: "Older conversation" }]);
      await appendTranscriptMessages(scope, {
        messages: Array.from({ length: 1001 }, (_, index) => ({
          eventId: `tool-${index}`,
          message: { role: "toolResult", content: "Hidden tool output" },
        })),
      });
      const first = await read(200);
      expect(first.items).toEqual([]);
      expect(first.nextCursor).toBeDefined();
      const second = await read(200, first.nextCursor);
      expect(second.items).toMatchObject([{ type: "userMessage", text: "Older conversation" }]);
      expect(second.nextCursor).toBeUndefined();
    });
  });

  it("redacts before clipping text and derives the same human title as local sessions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([
        { role: "user", content: "A useful session title" },
        {
          role: "assistant",
          content: `Authorization: Bearer synthetic-secret-token\n${"x".repeat(9000)}`,
        },
      ]);
      const page = await read(1);
      expect(page.items[0]).toMatchObject({ type: "agentMessage", truncated: true });
      expect(page.items[0]?.text).not.toContain("synthetic-secret-token");
      expect(page.items[0]?.text?.length).toBeLessThanOrEqual(6000);
      const entry = loadSessionEntryReadOnly(scope);
      if (!entry) {
        throw new Error("missing fixture entry");
      }
      expect(readSessionTranscriptCatalogTitle({ ...scope, entry })).toBe("A useful session title");
      expect(
        readSessionTranscriptCatalogTitle({
          ...scope,
          entry: { ...entry, label: "Named", displayName: "Display" },
        }),
      ).toBe("Named");
    });
  });

  it("keeps older-item cursors stable across append and rejects malformed or foreign cursors", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(["one", "two", "three"].map((content) => ({ role: "user", content })));
      const first = await read(2);
      if (!first.nextCursor) {
        throw new Error("missing fixture cursor");
      }
      const mixedProjectionCursor = JSON.parse(
        Buffer.from(first.nextCursor, "base64url").toString("utf8"),
      );
      // Before the text-only projection, cursor offsets also counted tools and thinking.
      mixedProjectionCursor.scope = createHash("sha256")
        .update(
          JSON.stringify([
            scope.agentId,
            scope.sessionKey,
            scope.sessionId,
            resolveSessionStorePathForScope(scope),
          ]),
        )
        .digest("base64url");
      await expect(
        read(2, Buffer.from(JSON.stringify(mixedProjectionCursor)).toString("base64url")),
      ).rejects.toThrow("no longer matches");
      await appendTranscriptMessage(scope, {
        eventId: "message-3",
        message: { role: "user", content: "four" },
      });
      const next = await read(2, first.nextCursor);
      expect(next.items.map((item) => item.text)).toEqual(["one"]);
      await expect(read(2, "not-a-cursor")).rejects.toThrow("Invalid session transcript cursor");
      for (const limit of [0, 201, 1.5, Number.NaN]) {
        await expect(read(limit)).rejects.toThrow("limit must be an integer");
      }
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:other" },
        { sessionId: "other-session", updatedAt: 1 },
      );
      await expect(
        readSessionTranscriptCatalogPage({
          ...source,
          agentId: "main",
          sessionKey: "agent:main:other",
          limit: 2,
          cursor: first.nextCursor,
        }),
      ).rejects.toThrow("no longer matches");
      await appendTranscriptEvent(scope, {
        type: "leaf",
        id: "rewind",
        parentId: "message-3",
        targetId: "message-0",
      });
      // The source writer owns rewind reconciliation; catalog reads cannot rebuild it.
      await reconcileSessionTranscriptIndexes({ agentId: scope.agentId });
      expect((await read(2)).items.map((item) => item.text)).toEqual(["one"]);
      await expect(read(2, first.nextCursor)).rejects.toThrow("no longer matches");
      for (const [eventId, parentId] of [
        ["replacement-two", "message-0"],
        ["replacement-three", "replacement-two"],
      ] as const) {
        await appendTranscriptMessage(scope, {
          eventId,
          parentId,
          message: { role: "user", content: eventId },
        });
      }
      // Equal-length branch replacements must not reuse the old ordinal as an anchor.
      await expect(read(2, first.nextCursor)).rejects.toThrow("no longer matches");
    });
  });

  it("exports portable senders and creators, linking only verified numeric GitHub identities on opt-in", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const github = syncGitHubIdentity({
        identity: { accountId: 12345, login: "portable-user", name: "Portable User" },
        authenticationAlias: { kind: "github-login", login: "portable-user" },
      });
      const local = ensureProfileForEmail("local@example.test");
      setDisplayName(local.id, "Local User");
      const observation = {
        type: "observation",
        pluginId: "fixture",
        accountId: null,
        senderKind: "human",
        id: "external-user",
      };
      await seed([
        {
          role: "user",
          content: "GitHub",
          __openclaw: { senderIdentity: { type: "profile", id: github.id } },
        },
        {
          role: "user",
          content: "Local",
          __openclaw: { senderIdentity: { type: "profile", id: local.id } },
        },
        {
          role: "user",
          content: "Observed",
          __openclaw: { senderIdentity: observation, senderName: "Observed User" },
        },
      ]);
      const page = await read(10);
      expect(page.items.map((item) => item.sender)).toEqual([
        { identity: observation, label: "Observed User" },
        {
          identity: {
            type: "remote",
            pluginId: source.pluginId,
            domain: source.sourceDomain,
            idKind: "profile",
            id: local.id,
          },
          label: "Local User",
        },
        {
          identity: {
            type: "remote",
            pluginId: source.pluginId,
            domain: source.sourceDomain,
            idKind: "github-account",
            id: "12345",
          },
          label: "Portable User",
        },
      ]);
      const sender = page.items[2]?.sender;
      if (!sender) {
        throw new Error("missing GitHub sender");
      }
      const linker = createSessionCatalogGitHubLinker();
      expect(linker.linkParticipant(sender)).toMatchObject({
        identity: { type: "profile", id: github.id },
        label: "Portable User",
      });
      const unmatched = {
        ...sender,
        identity: {
          type: "remote" as const,
          pluginId: "fixture",
          domain: "elsewhere",
          idKind: "github-account",
          id: "999",
        },
      };
      expect(linker.linkParticipant(unmatched)).toEqual(unmatched);
      expect(linker.resolveOwner("github:PORTABLE-USER")).toMatchObject({
        type: "human",
        id: github.id,
        identity: { type: "profile", id: github.id },
      });
      expect(linker.resolveOwner(`profile:${local.id}`)).toMatchObject({
        id: local.id,
        label: "Local User",
      });
      expect(linker.resolveOwner("github:missing")).toBeUndefined();
      const newlyVerified = syncGitHubIdentity({
        identity: { accountId: 999, login: "newly-verified", name: "Newly Verified" },
        authenticationAlias: { kind: "github-login", login: "newly-verified" },
      });
      expect(linker.linkParticipant(unmatched)).toEqual(unmatched);
      expect(linker.resolveOwner("github:newly-verified")).toBeUndefined();
      const nextPageLinker = createSessionCatalogGitHubLinker();
      expect(nextPageLinker.linkParticipant(unmatched)).toMatchObject({
        identity: { type: "profile", id: newlyVerified.id },
      });
      expect(nextPageLinker.resolveOwner("github:newly-verified")).toMatchObject({
        id: newlyVerified.id,
      });
      const projectActor = createSessionCatalogSourceActorProjector({
        ...source,
        actors: [{ type: "human", source: "profile", id: github.id }],
      });
      expect(projectActor({ type: "human", source: "profile", id: github.id })).toMatchObject({
        type: "human",
        identity: sender.identity,
        label: "Portable User",
      });
      expect(
        projectActor({ type: "human", source: "channel", id: github.id })?.identity,
      ).toBeUndefined();
      expect(projectActor({ type: "agent", id: "main", label: "Main" })).toEqual({
        type: "agent",
        id: "main",
        label: "Main",
      });
    });
  });

  it("does not create missing source session storage", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await expect(read(1)).rejects.toThrow("Session not found");
      expect(fs.existsSync(state.agentDir())).toBe(false);
    });
  });

  it("bounds repeated sender reads while refreshing merged and missing facts on the next page", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const canonical = syncGitHubIdentity({
        identity: { accountId: 12345, login: "catalog-user", name: "Canonical User" },
        authenticationAlias: { kind: "github-login", login: "catalog-user" },
      });
      const alias = ensureProfileForEmail("alias@example.test");
      linkEmail("alias@example.test", canonical.id);
      const missingId = "missing-profile";
      await seed(
        Array.from({ length: 24 }, (_, index) => ({
          role: "user",
          content: `Question ${index}`,
          __openclaw: {
            senderIdentity: { type: "profile", id: index % 2 === 0 ? alias.id : missingId },
            senderName: `Fallback ${index}`,
          },
        })),
      );
      const { db } = openOpenClawStateDatabase();
      const counter = trackSqliteStatementExecutions(db, ["attribution"], (query) =>
        /\bfrom\s+"?(?:user_profiles|user_profile_identities)\b/i.test(query)
          ? "attribution"
          : null,
      );
      let first: Awaited<ReturnType<typeof read>>;
      try {
        first = await read(12);
        expect.soft(counter.counts.attribution).toBeGreaterThan(0);
        expect.soft(counter.counts.attribution).toBeLessThanOrEqual(5);
        expect.soft(counter.rowCounts.attribution).toBeGreaterThan(0);
        expect.soft(counter.rowCounts.attribution).toBeLessThanOrEqual(3);
        expect.soft(counter.textBytes.attribution).toBeGreaterThan(0);
        expect.soft(counter.textBytes.attribution).toBeLessThan(512);
      } finally {
        counter.restore();
      }
      expect(
        first.items.map((item) => [item.text, item.sender?.identity.id, item.sender?.label]),
      ).toEqual(
        Array.from({ length: 12 }, (_, offset) => {
          const index = 23 - offset;
          return [
            `Question ${index}`,
            index % 2 === 0 ? "12345" : missingId,
            index % 2 === 0 ? "Canonical User" : `Fallback ${index}`,
          ];
        }),
      );
      expect(first.nextCursor).toBeDefined();
      setDisplayName(canonical.id, "Renamed User");
      db.prepare("DELETE FROM user_profile_identities WHERE provider = ? AND subject = ?").run(
        "github",
        "12345",
      );
      db.prepare(
        "INSERT INTO user_profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run(missingId, "New Profile", 1, 1);
      const second = await read(12, first.nextCursor);
      expect(
        second.items.map((item) => [item.text, item.sender?.identity.id, item.sender?.label]),
      ).toEqual(
        Array.from({ length: 12 }, (_, offset) => {
          const index = 11 - offset;
          return [
            `Question ${index}`,
            index % 2 === 0 ? canonical.id : missingId,
            index % 2 === 0 ? "Renamed User" : "New Profile",
          ];
        }),
      );
      expect(second.nextCursor).toBeUndefined();
    });
  });

  it("preserves native sender errors even when its content would be hidden", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("unsafe@example.test");
      await seed([
        {
          role: "user",
          content: [{ type: "tool_result", content: "Hidden" }],
          __openclaw: { senderIdentity: { type: "profile", id: profile.id } },
        },
      ]);
      const { db } = openOpenClawStateDatabase();
      db.prepare("UPDATE user_profiles SET updated_at = ? WHERE id = ?").run(
        9223372036854775807n,
        profile.id,
      );
      let nativeError: unknown;
      try {
        getUserProfileDisplay(profile.id);
      } catch (error) {
        nativeError = error;
      }
      expect(nativeError).toBeInstanceOf(Error);
      expect(nativeError).toMatchObject({ code: "ERR_OUT_OF_RANGE" });
      if (!(nativeError instanceof Error)) {
        throw new Error("Expected native integer decoding to fail");
      }
      await expect(read(1)).rejects.toMatchObject({
        name: nativeError.name,
        message: nativeError.message,
        code: "ERR_OUT_OF_RANGE",
      });
    });
  });
});
