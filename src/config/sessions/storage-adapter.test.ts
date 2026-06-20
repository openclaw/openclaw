import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { jsonSessionStoreAdapter } from "./json-store-adapter.js";
import type { SessionStoreAdapter, SessionStoreRecord } from "./storage-adapter.js";

const fixtureStore = (): SessionStoreRecord => ({
  "agent:main:older": {
    sessionId: "session-older",
    updatedAt: 10,
    sessionStartedAt: 1,
    label: "backlog",
  },
  "agent:main:newer": {
    sessionId: "session-newer",
    updatedAt: 30,
    sessionStartedAt: 2,
    label: "focus",
  },
  "agent:main:middle": {
    sessionId: "session-middle",
    updatedAt: 20,
    sessionStartedAt: 3,
    label: "focus",
  },
});

async function writeFixtureStore(storePath: string, store: SessionStoreRecord = fixtureStore()) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function runSessionStoreAdapterContract(name: string, adapter: SessionStoreAdapter) {
  describe(`${name} session store adapter contract`, () => {
    it("loads and reads individual entries without exposing caller mutations", async () => {
      await withTempDir({ prefix: `openclaw-${name}-adapter-load-` }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await writeFixtureStore(storePath);

        const loaded = await adapter.loadStore(storePath);
        loaded["agent:main:newer"]!.sessionId = "mutated-by-caller";

        await expect(adapter.readEntry(storePath, "agent:main:newer")).resolves.toMatchObject({
          sessionId: "session-newer",
          updatedAt: 30,
        });
      });
    });

    it("provides bounded, ordered list reads with total count metadata", async () => {
      await withTempDir({ prefix: `openclaw-${name}-adapter-list-` }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await writeFixtureStore(storePath);

        await expect(
          adapter.listEntries(storePath, {
            limit: 2,
            excludeKeys: ["agent:main:newer"],
            orderBy: "updatedAt_desc",
          }),
        ).resolves.toMatchObject({
          entries: [
            ["agent:main:middle", expect.objectContaining({ sessionId: "session-middle" })],
            ["agent:main:older", expect.objectContaining({ sessionId: "session-older" })],
          ],
          totalCount: 2,
          limitApplied: 2,
          hasMore: false,
        });

        await expect(
          adapter.listEntries(storePath, { limit: 1, offset: 2, orderBy: "updatedAt_desc" }),
        ).resolves.toMatchObject({
          entries: [["agent:main:older", expect.objectContaining({ sessionId: "session-older" })]],
          totalCount: 3,
          limitApplied: 1,
          offset: 2,
          hasMore: false,
        });

        await expect(
          adapter.listEntries(storePath, { limit: 1, offset: 99, orderBy: "updatedAt_desc" }),
        ).resolves.toMatchObject({
          entries: [],
          totalCount: 3,
          limitApplied: 1,
          offset: 99,
          hasMore: false,
        });

        await expect(
          adapter.listEntries(storePath, {
            label: "focus",
            updatedAfter: 15,
            limit: 5,
            orderBy: "updatedAt_desc",
          }),
        ).resolves.toMatchObject({
          entries: [
            ["agent:main:newer", expect.objectContaining({ sessionId: "session-newer" })],
            ["agent:main:middle", expect.objectContaining({ sessionId: "session-middle" })],
          ],
          totalCount: 2,
          limitApplied: 5,
          hasMore: false,
        });
      });
    });

    it("applies persisted spawnedBy and store-indexed search filters before windowing", async () => {
      await withTempDir({ prefix: `openclaw-${name}-adapter-indexed-filter-` }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await writeFixtureStore(storePath, {
          "agent:main:parent": {
            sessionId: "session-parent",
            updatedAt: 100,
            label: "root",
          },
          "agent:main:child-one": {
            sessionId: "session-child-one",
            updatedAt: 90,
            spawnedBy: "agent:main:parent",
            subject: "Quarterly planning",
            modelProvider: "openai",
            model: "gpt-4.1",
          },
          "agent:main:child-two": {
            sessionId: "session-child-two",
            updatedAt: 80,
            parentSessionKey: "agent:main:parent",
            displayName: "Publisher audit lane",
          },
          "agent:main:other": {
            sessionId: "session-other",
            updatedAt: 70,
            spawnedBy: "agent:main:elsewhere",
            subject: "Quarterly planning",
          },
        });

        await expect(
          adapter.listEntries(storePath, {
            spawnedBy: "agent:main:parent",
            search: "audit",
            limit: 5,
          }),
        ).resolves.toMatchObject({
          entries: [
            [
              "agent:main:child-two",
              expect.objectContaining({
                sessionId: "session-child-two",
                parentSessionKey: "agent:main:parent",
              }),
            ],
          ],
          totalCount: 1,
          limitApplied: 5,
          hasMore: false,
        });

        await expect(
          adapter.listEntries(storePath, {
            search: "openai/gpt-4.1",
            limit: 5,
          }),
        ).resolves.toMatchObject({
          entries: [
            ["agent:main:child-one", expect.objectContaining({ sessionId: "session-child-one" })],
          ],
          totalCount: 1,
        });
      });
    });

    it("serializes update mutations through the adapter", async () => {
      await withTempDir({ prefix: `openclaw-${name}-adapter-update-` }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await writeFixtureStore(storePath);

        const returned = await adapter.updateStore(
          storePath,
          (store) => {
            store["agent:main:newer"] = {
              ...store["agent:main:newer"]!,
              updatedAt: 40,
              model: "updated-model",
            };
            return store["agent:main:newer"]!.sessionId;
          },
          { skipMaintenance: true, activeSessionKey: "agent:main:newer" },
        );

        expect(returned).toBe("session-newer");
        await expect(adapter.readEntry(storePath, "agent:main:newer")).resolves.toMatchObject({
          sessionId: "session-newer",
          updatedAt: 40,
          model: "updated-model",
        });
      });
    });

    it("saves whole-store replacements for migration/fallback flows", async () => {
      await withTempDir({ prefix: `openclaw-${name}-adapter-save-` }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await adapter.saveStore(
          storePath,
          {
            "agent:main:only": {
              sessionId: "session-only",
              updatedAt: 5,
              sessionStartedAt: 5,
            },
          },
          { skipMaintenance: true, activeSessionKey: "agent:main:only" },
        );

        await expect(adapter.loadStore(storePath)).resolves.toMatchObject({
          "agent:main:only": { sessionId: "session-only", updatedAt: 5 },
        });
      });
    });

    it("can upsert entry batches without replacing unrelated entries when supported", async () => {
      const writeEntries = adapter.writeEntries;
      if (!writeEntries) {
        return;
      }
      await withTempDir({ prefix: `openclaw-${name}-adapter-write-` }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await writeFixtureStore(storePath);

        await writeEntries(
          storePath,
          [
            [
              "agent:main:newer",
              { sessionId: "session-newer-updated", updatedAt: 50, sessionStartedAt: 2 },
            ],
            ["agent:main:added", { sessionId: "session-added", updatedAt: 60 }],
          ],
          { skipMaintenance: true },
        );

        await expect(adapter.loadStore(storePath)).resolves.toMatchObject({
          "agent:main:older": { sessionId: "session-older", updatedAt: 10 },
          "agent:main:newer": { sessionId: "session-newer-updated", updatedAt: 50 },
          "agent:main:added": { sessionId: "session-added", updatedAt: 60 },
        });
      });
    });

    it("can delete selected entries without replacing unrelated entries when supported", async () => {
      const deleteEntries = adapter.deleteEntries;
      if (!deleteEntries) {
        return;
      }
      await withTempDir({ prefix: `openclaw-${name}-adapter-delete-` }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await writeFixtureStore(storePath);

        await deleteEntries(storePath, ["agent:main:middle"], { skipMaintenance: true });

        await expect(adapter.loadStore(storePath)).resolves.toMatchObject({
          "agent:main:older": { sessionId: "session-older", updatedAt: 10 },
          "agent:main:newer": { sessionId: "session-newer", updatedAt: 30 },
        });
        await expect(adapter.readEntry(storePath, "agent:main:middle")).resolves.toBeUndefined();
      });
    });
  });
}

runSessionStoreAdapterContract("json", jsonSessionStoreAdapter);
