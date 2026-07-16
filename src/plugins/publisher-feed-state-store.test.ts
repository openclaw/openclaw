import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createSqlitePublisherFeedStateStore } from "./publisher-feed-state-store.js";

const tempDirs: string[] = [];

function makeRecord(sequence = 7) {
  return {
    sourceOrigin: "https://clawhub.ai",
    state: {
      feedId: "clawhub.publisher.publishers:alice",
      sequence,
      generatedAt: `2026-07-16T00:00:0${sequence}.000Z`,
      publisherId: "publishers:alice",
      handle: "alice",
      displayName: "Alice",
      entries: [
        {
          kind: "skill" as const,
          id: "skills:cuda",
          name: "cuda-helper",
          displayName: "CUDA Helper",
          summary: "GPU tools",
          url: "/alice/skills/cuda-helper",
          updatedAt: 2,
        },
      ],
    },
    verification: {
      signedBy: "clawhub-feed-2026-q3",
      signedByKeyIds: ["clawhub-feed-2026-q3"],
      signatureCount: 1,
      threshold: 1,
    },
    verifiedAt: "2026-07-16T00:01:00.000Z",
  };
}

afterEach(() => {
  closeOpenClawStateDatabase();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("publisher feed state store", () => {
  it("persists accepted publisher state and signing evidence", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publisher-feed-state-"));
    tempDirs.push(directory);
    const store = createSqlitePublisherFeedStateStore({
      stateDatabasePath: path.join(directory, "state.sqlite"),
    });

    expect(await store.read("https://clawhub.ai", "publishers:alice")).toBeNull();
    await store.write(makeRecord());
    expect(await store.read("https://clawhub.ai/", "publishers:alice")).toEqual(makeRecord());
  });

  it("rejects rollback and same-sequence content changes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publisher-feed-state-"));
    tempDirs.push(directory);
    const store = createSqlitePublisherFeedStateStore({
      stateDatabasePath: path.join(directory, "state.sqlite"),
    });
    const unsorted = {
      ...makeRecord(7),
      state: {
        ...makeRecord(7).state,
        entries: [
          { ...makeRecord(7).state.entries[0]!, id: "skills:a" },
          { ...makeRecord(7).state.entries[0]!, id: "skills:Z" },
        ],
      },
    };
    await store.write(unsorted);
    await store.write({
      ...unsorted,
      state: {
        ...unsorted.state,
        entries: unsorted.state.entries.toReversed(),
      },
    });

    await expect(store.write(makeRecord(6))).rejects.toThrow("older than accepted");
    await expect(
      store.write({
        ...makeRecord(7),
        state: { ...makeRecord(7).state, displayName: "Changed" },
      }),
    ).rejects.toThrow("without a sequence increment");
    await store.write(makeRecord(8));
    expect((await store.read("https://clawhub.ai", "publishers:alice"))?.state.sequence).toBe(8);
  });
});
