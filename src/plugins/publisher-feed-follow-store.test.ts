import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createSqlitePublisherFeedFollowStore } from "./publisher-feed-follow-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabase();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("publisher feed follow store", () => {
  it("persists, updates, lists, and removes follows", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publisher-feed-follow-"));
    tempDirs.push(directory);
    const store = createSqlitePublisherFeedFollowStore({
      stateDatabasePath: path.join(directory, "state.sqlite"),
    });

    expect(await store.list()).toEqual([]);
    await store.follow({
      sourceOrigin: "https://clawhub.ai/",
      publisherId: " publishers:alice ",
      feedProfile: " clawhub-signed ",
      nowMs: 10,
    });
    await store.follow({
      sourceOrigin: "https://clawhub.ai",
      publisherId: "publishers:alice",
      feedProfile: "clawhub-rotated",
      nowMs: 20,
    });

    expect(await store.list()).toEqual([
      {
        sourceOrigin: "https://clawhub.ai",
        publisherId: "publishers:alice",
        feedProfile: "clawhub-rotated",
        createdAtMs: 10,
        updatedAtMs: 20,
      },
    ]);
    await expect(store.unfollow("https://clawhub.ai", "publishers:alice")).resolves.toBe(true);
    await expect(store.unfollow("https://clawhub.ai", "publishers:alice")).resolves.toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("rejects unsafe origins and invalid identities before opening SQLite", async () => {
    const store = createSqlitePublisherFeedFollowStore({
      stateDatabasePath: path.join(os.tmpdir(), `missing-${Date.now()}`, "state.sqlite"),
    });
    await expect(
      store.follow({
        sourceOrigin: "http://clawhub.ai",
        publisherId: "publishers:alice",
        feedProfile: "clawhub-signed",
      }),
    ).rejects.toThrow("HTTPS origin");
    await expect(
      store.follow({
        sourceOrigin: "https://clawhub.ai",
        publisherId: " ",
        feedProfile: "clawhub-signed",
      }),
    ).rejects.toThrow("publisher id is invalid");
  });
});
