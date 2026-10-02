import type { MakeDirectoryOptions, Mode, PathLike } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadLegacySessionStore,
  saveLegacySessionStore,
} from "./state-migrations.legacy-session-store.js";
import { resolveStaleLegacySessionFile } from "./state-migrations.session-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DAY_MS = 24 * 60 * 60 * 1000;
const MODEL_KEY = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
const MAIN_KEY = "agent:main:main";
const legacyEntry = {
  sessionId: " session-1 ",
  updatedAt: 1,
  channel: "slack",
  provider: false,
  lastProvider: false,
  room: false,
  pendingFinalDeliveryAttemptCount: -1,
};
let root: string;
let storePath: string;
beforeEach(() => {
  root = tempDirs.make("openclaw-legacy-session-");
  storePath = path.join(root, "sessions.json");
});
const writeStore = (value: unknown) => fs.writeFile(storePath, JSON.stringify(value));
function maintain(modelRunPruneAfterMs: number) {
  return loadLegacySessionStore(storePath, {
    runMaintenance: true,
    maintenanceConfig: {
      mode: "enforce",
      pruneAfterMs: 30 * DAY_MS,
      archiveDashboardAfterMs: null,
      modelRunPruneAfterMs,
      maxEntries: 2,
      preserveRecentMs: null,
      resetArchiveRetentionMs: null,
      maxDiskBytes: null,
      highWaterBytes: null,
    },
  });
}
function expectNormalized(store: Record<string, unknown>, channel: string) {
  expect(store.malformed).toBeUndefined();
  expect(store[MAIN_KEY]).toMatchObject({
    sessionId: "session-1",
    delivery: { kind: "external", context: { channel }, origin: { provider: channel } },
  });
  for (const key of ["channel", "lastChannel", "pendingFinalDeliveryAttemptCount"]) {
    expect(store[MAIN_KEY]).not.toHaveProperty(key);
  }
}

it.each([DAY_MS, 0])(
  "applies model-run retention %s during legacy maintenance",
  async (retention) => {
    const now = Date.now();
    await writeStore({
      [MODEL_KEY]: { sessionId: "session-model-run", updatedAt: now - 2 * DAY_MS },
      "agent:main:old": { sessionId: "session-old", updatedAt: now - 3 * DAY_MS },
      "agent:main:active": { sessionId: "session-active", updatedAt: now },
    });
    const store = maintain(retention);
    const present = retention === 0;
    expect(store[MODEL_KEY] != null).toBe(present);
    expect(Object.keys(store)).toHaveLength(present ? 3 : 2);
    expect(Object.values(store).filter((entry) => entry.archivedAt === undefined)).toHaveLength(2);
    expect(store["agent:main:active"]).toMatchObject({ sessionId: "session-active" });
    expect(store["agent:main:active"]?.archivedAt).toBeUndefined();
    expect(store["agent:main:old"]).toMatchObject({ sessionId: "session-old" });
    if (present) {
      expect(store[MODEL_KEY]).toMatchObject({ sessionId: "session-model-run" });
      expect(store[MODEL_KEY]?.archivedAt).toBeUndefined();
      expect(store["agent:main:old"]?.archivedAt).toEqual(expect.any(Number));
    } else {
      expect(store["agent:main:old"]?.archivedAt).toBeUndefined();
    }
  },
);

it("does not treat archived rows as legacy maintenance pressure", async () => {
  const now = Date.now();
  await writeStore({
    [MODEL_KEY]: { sessionId: "session-model-run", updatedAt: now - 2 * DAY_MS },
    "agent:main:active": { sessionId: "session-active", updatedAt: now },
    "agent:main:archived": {
      archivedAt: now - DAY_MS,
      sessionId: "session-archived",
      updatedAt: now - 3 * DAY_MS,
    },
  });
  const store = maintain(DAY_MS);
  expect(store[MODEL_KEY]).toBeDefined();
  expect(store["agent:main:archived"]?.archivedAt).toBe(now - DAY_MS);
});

it("stages prompt blobs after a recreated session directory", async () => {
  const storeDir = path.join(root, "sessions");
  storePath = path.join(storeDir, "sessions.json");
  const prompt = `<available_skills>\n${"recreated dir prompt\n".repeat(200)}</available_skills>`;
  const realMkdir = fs.mkdir.bind(fs);
  let mkdirs = 0;
  const spy = vi
    .spyOn(fs, "mkdir")
    .mockImplementation(async (dir: PathLike, options?: MakeDirectoryOptions | Mode | null) => {
      if (
        typeof dir === "string" &&
        path.resolve(dir) === path.resolve(storeDir) &&
        ++mkdirs === 2
      ) {
        await fs.rm(storeDir, { force: true, recursive: true });
      }
      return await realMkdir(dir, options ?? undefined);
    });
  try {
    await saveLegacySessionStore(
      storePath,
      {
        [MAIN_KEY]: {
          sessionId: "session-1",
          updatedAt: 1,
          skillsSnapshot: { prompt, skills: [{ name: "demo" }], version: 1 },
        },
      },
      { skipMaintenance: true },
    );
  } finally {
    spy.mockRestore();
  }
  expect(mkdirs).toBeGreaterThanOrEqual(2);
  expect(loadLegacySessionStore(storePath)[MAIN_KEY]?.skillsSnapshot?.prompt).toBe(prompt);
});

it("normalizes file-era rows and drops malformed entries", async () => {
  await writeStore({
    malformed: null,
    [MAIN_KEY]: {
      ...legacyEntry,
      lastChannel: "telegram",
      pluginExtensions: { " demo ": { " valid ": { ok: true }, invalid: undefined } },
    },
  });
  const store = loadLegacySessionStore(storePath);
  expectNormalized(store, "telegram");
  expect(store[MAIN_KEY]?.pluginExtensions).toEqual({ demo: { valid: { ok: true } } });
});

it("normalizes compatibility writes before persistence", async () => {
  const skillsSnapshot = {
    prompt: "compact skill prompt",
    skills: [{ name: "demo" }],
    skillFilter: ["demo"],
    version: 7,
  };
  const store = {
    malformed: null,
    [MAIN_KEY]: {
      ...legacyEntry,
      provider: "obsolete-provider",
      lastProvider: "obsolete-provider",
      lastChannel: "slack",
      skillsSnapshot: {
        ...skillsSnapshot,
        resolvedSkills: [{ name: "demo", description: "runtime-only catalog" }],
      },
    },
  } as unknown as Parameters<typeof saveLegacySessionStore>[1];
  await saveLegacySessionStore(storePath, store, { skipMaintenance: true });
  const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  expectNormalized(persisted, "slack");
  expect(persisted[MAIN_KEY]?.skillsSnapshot).toMatchObject(skillsSnapshot);
  expect(persisted[MAIN_KEY]?.skillsSnapshot).not.toHaveProperty("resolvedSkills");
  expectNormalized(loadLegacySessionStore(storePath), "slack");
});

it("repairs a stale session file whose header straddles the read chunk boundary", async () => {
  const sessionId = "sess-boundary-1";
  const legacyDir = path.join(root, "legacy-sessions");
  const targetDir = path.join(root, "sessions");
  await fs.mkdir(legacyDir);
  await fs.mkdir(targetDir);
  const legacySessionFile = path.join(legacyDir, `${sessionId}.jsonl`);
  const targetSessionFile = path.join(targetDir, `${sessionId}.jsonl`);
  // The three-byte character begins at 8191, splitting it across read chunks.
  const prefix = Buffer.from(`{"type":"session","id":"${sessionId}","pad":"`);
  await fs.writeFile(
    targetSessionFile,
    Buffer.concat([prefix, Buffer.from("a".repeat(8191 - prefix.length)), Buffer.from('中"}\n')]),
  );
  expect(
    resolveStaleLegacySessionFile({
      entry: { sessionId, sessionFile: legacySessionFile },
      legacyDir,
      targetDir,
    }),
  ).toBe(targetSessionFile);
});
