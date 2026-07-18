import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSqliteHostedOfficialExternalPluginCatalogSnapshotStore } from "./official-external-plugin-catalog-snapshot-store.js";
import {
  addMarketplaceFeedWatch,
  dismissMarketplaceFeedUpdate,
  listMarketplaceFeedUpdates,
  listMarketplaceFeedWatches,
  markMarketplaceFeedUpdateRead,
  removeMarketplaceFeedWatch,
  setMarketplaceFeedWatchMuted,
} from "./official-external-plugin-catalog-watch-store.js";

const tempDirs: string[] = [];
const feedUrl = "https://clawhub.ai/v1/feeds/plugins";
const feedId = "clawhub-official";

function tempDatabasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-feed-watch-"));
  tempDirs.push(dir);
  return path.join(dir, "state.sqlite");
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "demo",
    title: "Demo",
    kind: "plugin",
    name: "@acme/demo",
    version: "1.0.0",
    state: "community",
    publisher: { id: "acme", trust: "community" },
    install: {
      candidates: [
        {
          sourceRef: "public-npm",
          package: "@acme/demo",
          version: "1.0.0",
          integrity: "sha512-ZGVtbw==",
        },
      ],
    },
    ...overrides,
  };
}

function feedBody(sequence: number, entries = [entry()]): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: feedId,
    generatedAt: new Date(Date.UTC(2026, 6, 17, 0, sequence)).toISOString(),
    sequence,
    entries,
  });
}

function snapshot(body: string, sequence: number) {
  return {
    body,
    metadata: {
      url: feedUrl,
      status: 200,
      checksum: `sha256:${sequence}`,
    },
    savedAt: new Date(Date.UTC(2026, 6, 17, 0, sequence)).toISOString(),
    trust: {
      mode: "signed" as const,
      signedBy: "clawhub-feed-2026",
      signatureCount: 1,
      threshold: 1,
      verifiedAt: new Date(Date.UTC(2026, 6, 17, 0, sequence)).toISOString(),
    },
    monotonic: {
      mode: "signed-feed" as const,
      sequence,
      generatedAt: new Date(Date.UTC(2026, 6, 17, 0, sequence)).toISOString(),
    },
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("marketplace feed watch store", () => {
  it("suppresses the baseline and materializes verified version, blocked, and removal updates", async () => {
    const stateDatabasePath = tempDatabasePath();
    const options = { stateDatabasePath };
    const snapshots = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore(options);

    await snapshots.write(snapshot(feedBody(1), 1));
    const added = addMarketplaceFeedWatch(
      {
        feedId,
        feedProfile: "clawhub-public",
        feedUrl,
        itemKind: "plugin",
        itemId: "demo",
        sequence: 1,
        baselineEntry: entry(),
      },
      options,
    );
    expect(added.created).toBe(true);
    expect(listMarketplaceFeedUpdates({}, options)).toEqual([]);
    const version11 = {
      version: "1.1.0",
      install: {
        candidates: [
          {
            sourceRef: "public-npm",
            package: "@acme/demo",
            version: "1.1.0",
            integrity: "sha512-djEuMS4w",
          },
        ],
      },
    };

    await snapshots.write(snapshot(feedBody(2, [entry(version11)]), 2));
    await snapshots.write(
      snapshot(
        feedBody(3, [
          entry({
            version: "1.1.0",
            install: {
              candidates: [
                {
                  integrity: "sha512-djEuMS4w",
                  version: "1.1.0",
                  package: "@acme/demo",
                  sourceRef: "public-npm",
                },
              ],
            },
            title: "Renamed Demo",
            description: "cosmetic",
          }),
        ]),
        3,
      ),
    );
    await snapshots.write(snapshot(feedBody(4, [entry({ ...version11, state: "blocked" })]), 4));
    await snapshots.write(snapshot(feedBody(5, []), 5));

    const updates = listMarketplaceFeedUpdates({}, options);
    expect(updates.map((update) => update.reason)).toEqual(["removed", "blocked", "updated"]);
    expect(updates.map((update) => update.feedSequence)).toEqual([5, 4, 2]);
    expect(listMarketplaceFeedWatches(options)).toMatchObject([
      { itemId: "demo", lastSequence: 5, muted: false },
    ]);

    const eventId = updates[0]!.eventId;
    expect(markMarketplaceFeedUpdateRead(eventId, options)).toBe(true);
    expect(markMarketplaceFeedUpdateRead(eventId, options)).toBe(true);
    expect(listMarketplaceFeedUpdates({ unreadOnly: true }, options)).toHaveLength(2);
    expect(dismissMarketplaceFeedUpdate(eventId, options)).toBe(true);
    expect(dismissMarketplaceFeedUpdate(eventId, options)).toBe(true);
    expect(markMarketplaceFeedUpdateRead("missing-event", options)).toBe(false);
    expect(listMarketplaceFeedUpdates({}, options)).toHaveLength(2);
    expect(listMarketplaceFeedUpdates({ includeDismissed: true }, options)).toHaveLength(3);
  });

  it("keeps watch operations idempotent and persists mute state", async () => {
    const stateDatabasePath = tempDatabasePath();
    const options = { stateDatabasePath };
    const input = {
      feedId,
      feedProfile: "clawhub-public",
      feedUrl,
      itemKind: "plugin" as const,
      itemId: "demo",
      sequence: 7,
      baselineEntry: entry(),
    };

    expect(addMarketplaceFeedWatch(input, options).created).toBe(true);
    expect(addMarketplaceFeedWatch({ ...input, sequence: 8 }, options)).toMatchObject({
      created: false,
      watch: { lastSequence: 7 },
    });
    expect(
      setMarketplaceFeedWatchMuted(
        { feedId, itemKind: "plugin", itemId: "demo", muted: true },
        options,
      ),
    ).toBe(true);
    expect(listMarketplaceFeedWatches(options)).toMatchObject([{ muted: true }]);
    expect(
      removeMarketplaceFeedWatch({ feedId, itemKind: "plugin", itemId: "demo" }, options),
    ).toBe(true);
    expect(
      removeMarketplaceFeedWatch({ feedId, itemKind: "plugin", itemId: "demo" }, options),
    ).toBe(false);
  });

  it("advances a muted watch baseline without creating update events", async () => {
    const stateDatabasePath = tempDatabasePath();
    const options = { stateDatabasePath };
    const snapshots = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore(options);
    await snapshots.write(snapshot(feedBody(1), 1));
    addMarketplaceFeedWatch(
      {
        feedId,
        feedUrl,
        itemKind: "plugin",
        itemId: "demo",
        sequence: 1,
        baselineEntry: entry(),
      },
      options,
    );
    setMarketplaceFeedWatchMuted(
      { feedId, itemKind: "plugin", itemId: "demo", muted: true },
      options,
    );

    await snapshots.write(snapshot(feedBody(2, [entry({ version: "2.0.0" })]), 2));
    expect(listMarketplaceFeedUpdates({}, options)).toEqual([]);
    expect(listMarketplaceFeedWatches(options)).toMatchObject([{ lastSequence: 2, muted: true }]);

    setMarketplaceFeedWatchMuted(
      { feedId, itemKind: "plugin", itemId: "demo", muted: false },
      options,
    );
    await snapshots.write(snapshot(feedBody(3, [entry({ version: "3.0.0" })]), 3));
    expect(listMarketplaceFeedUpdates({}, options)).toMatchObject([
      { feedSequence: 3, reason: "updated" },
    ]);
    expect(listMarketplaceFeedWatches(options)).toMatchObject([{ lastSequence: 3, muted: false }]);
  });

  it("does not advance a watch from another source reusing the same feed id", async () => {
    const stateDatabasePath = tempDatabasePath();
    const options = { stateDatabasePath };
    const snapshots = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore(options);
    await snapshots.write(snapshot(feedBody(1), 1));
    addMarketplaceFeedWatch(
      {
        feedId,
        feedUrl,
        itemKind: "plugin",
        itemId: "demo",
        sequence: 1,
        baselineEntry: entry(),
      },
      options,
    );

    const imposterUrl = "https://packages.example.test/v1/feeds/plugins";
    await snapshots.write({
      ...snapshot(feedBody(2, [entry({ version: "2.0.0" })]), 2),
      metadata: { url: imposterUrl, status: 200, checksum: "sha256:imposter" },
    });
    expect(listMarketplaceFeedUpdates({}, options)).toEqual([]);
    expect(listMarketplaceFeedWatches(options)).toMatchObject([{ lastSequence: 1 }]);

    await snapshots.write(snapshot(feedBody(2, [entry({ version: "2.0.0" })]), 2));
    expect(listMarketplaceFeedUpdates({}, options)).toMatchObject([
      { feedSequence: 2, reason: "updated" },
    ]);
    expect(listMarketplaceFeedWatches(options)).toMatchObject([{ lastSequence: 2 }]);
  });

  it("does not materialize updates from unsigned snapshot writes", async () => {
    const stateDatabasePath = tempDatabasePath();
    const options = { stateDatabasePath };
    const snapshots = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore(options);
    await snapshots.write(snapshot(feedBody(1), 1));
    addMarketplaceFeedWatch(
      {
        feedId,
        feedUrl,
        itemKind: "plugin",
        itemId: "demo",
        sequence: 1,
        baselineEntry: entry(),
      },
      options,
    );

    await snapshots.write({
      body: feedBody(2, [entry({ version: "2.0.0" })]),
      metadata: { url: feedUrl, status: 200, checksum: "sha256:unsigned" },
      savedAt: "2026-07-17T00:02:00.000Z",
    });

    expect(listMarketplaceFeedUpdates({}, options)).toEqual([]);
    expect(listMarketplaceFeedWatches(options)).toMatchObject([{ lastSequence: 1 }]);

    await snapshots.write(
      snapshot(
        feedBody(3, [
          entry({
            version: "3.0.0",
            install: {
              candidates: [{ sourceRef: "public-npm", package: "@acme/demo", version: "3.0.0" }],
            },
          }),
        ]),
        3,
      ),
    );
    expect(listMarketplaceFeedUpdates({}, options)).toMatchObject([
      { feedSequence: 3, reason: "updated" },
    ]);
    expect(listMarketplaceFeedWatches(options)).toMatchObject([{ lastSequence: 3 }]);
  });
});
