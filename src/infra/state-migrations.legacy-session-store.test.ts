import type { MakeDirectoryOptions, Mode, PathLike } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readLegacySessionStoreEntries } from "../config/sessions/legacy-store-inspection.js";
import {
  loadLegacySessionStore,
  saveLegacySessionStore,
} from "./state-migrations.legacy-session-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MAIN_KEY = "agent:main:main";
const legacyEntry = {
  sessionId: " session-1 ",
  updatedAt: 1,
  channel: "slack",
  provider: false,
  lastProvider: false,
  pendingFinalDeliveryAttemptCount: -1,
};
let root: string;
let storePath: string;
beforeEach(() => {
  root = tempDirs.make("openclaw-legacy-session-");
  storePath = path.join(root, "sessions.json");
});
const writeStore = (value: unknown) => fs.writeFile(storePath, JSON.stringify(value));
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

it("preserves retired room-only source bytes across inspection, loading, and refused writes", async () => {
  const store = { [MAIN_KEY]: { sessionId: "session-room", updatedAt: 1, room: "#legacy" } };
  const raw = `${JSON.stringify(store, null, 2)}\n`;
  await fs.writeFile(storePath, raw);
  expect(() => readLegacySessionStoreEntries({ storePath }, [])).toThrow(/2026\.9\.5/);
  expect(() => loadLegacySessionStore(storePath)).toThrow(/2026\.9\.5/);
  await expect(saveLegacySessionStore(storePath, store, { skipMaintenance: true })).rejects.toThrow(
    /2026\.9\.5/,
  );
  expect(await fs.readFile(storePath, "utf8")).toBe(raw);
});

it("imports provider-only fields still preserved by the July Doctor writer", async () => {
  await writeStore({
    [MAIN_KEY]: {
      sessionId: "session-1",
      updatedAt: 1,
      provider: "slack",
      lastProvider: "telegram",
    },
  });
  const raw = await fs.readFile(storePath, "utf8");
  expectNormalized(loadLegacySessionStore(storePath), "telegram");
  expect(await fs.readFile(storePath, "utf8")).toBe(raw);
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
