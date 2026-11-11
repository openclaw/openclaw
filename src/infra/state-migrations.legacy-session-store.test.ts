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
afterEach(() => vi.restoreAllMocks());
const MAIN_KEY = "agent:main:main";
type Store = ReturnType<typeof loadLegacySessionStore>;
let storePath: string;
beforeEach(() => {
  storePath = path.join(tempDirs.make("openclaw-legacy-session-"), "sessions.json");
});
const writeStore = (value: unknown) => fs.writeFile(storePath, JSON.stringify(value));
function mainStore<T extends object>(entry: T) {
  return { [MAIN_KEY]: { sessionId: "session-1", updatedAt: 1, ...entry } };
}
const saveStore = (store: Store) =>
  saveLegacySessionStore(storePath, store, { skipMaintenance: true });
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
  const storeDir = path.join(path.dirname(storePath), "sessions");
  storePath = path.join(storeDir, "sessions.json");
  const prompt = `<available_skills>\n${"recreated dir prompt\n".repeat(200)}</available_skills>`;
  const realMkdir = fs.mkdir.bind(fs);
  let mkdirs = 0;
  vi.spyOn(fs, "mkdir").mockImplementation(async (dir, options) => {
    if (typeof dir === "string" && path.resolve(dir) === path.resolve(storeDir) && ++mkdirs === 2) {
      await fs.rm(storeDir, { force: true, recursive: true });
    }
    return await realMkdir(dir, options ?? undefined);
  });
  await saveStore(
    mainStore({ skillsSnapshot: { prompt, skills: [{ name: "demo" }], version: 1 } }),
  );
  expect(mkdirs).toBeGreaterThanOrEqual(2);
  expect(loadLegacySessionStore(storePath)[MAIN_KEY]?.skillsSnapshot?.prompt).toBe(prompt);
});

it.each(["read", "write"] as const)("normalizes legacy rows during %s", async (mode) => {
  const channel = mode === "read" ? "telegram" : "slack";
  const provider = mode === "read" ? false : "obsolete-provider";
  const skillsSnapshot = {
    prompt: "compact skill prompt",
    skills: [{ name: "demo" }],
    skillFilter: ["demo"],
    version: 7,
  };
  const store = {
    malformed: null,
    ...mainStore({
      sessionId: " session-1 ",
      channel: "slack",
      pendingFinalDeliveryAttemptCount: -1,
      provider,
      lastProvider: provider,
      lastChannel: channel,
      pluginExtensions: { " demo ": { " valid ": { ok: true }, invalid: undefined } },
      skillsSnapshot: {
        ...skillsSnapshot,
        resolvedSkills: [{ name: "demo", description: "runtime-only catalog" }],
      },
    }),
  } as unknown as Store;
  await (mode === "read" ? writeStore(store) : saveStore(store));
  const raw = await fs.readFile(storePath, "utf8");
  const normalized: Store = mode === "read" ? loadLegacySessionStore(storePath) : JSON.parse(raw);
  expectNormalized(normalized, channel);
  expect(normalized[MAIN_KEY]?.pluginExtensions).toEqual({ demo: { valid: { ok: true } } });
  expect(normalized[MAIN_KEY]?.skillsSnapshot).toMatchObject(skillsSnapshot);
  expect(normalized[MAIN_KEY]?.skillsSnapshot).not.toHaveProperty("resolvedSkills");
  expectNormalized(loadLegacySessionStore(storePath), channel);
  expect(await fs.readFile(storePath, "utf8")).toBe(raw);
});

it("preserves retired room-only source bytes across inspection, loading, and refused writes", async () => {
  const store = mainStore({ sessionId: "session-room", room: "#legacy" });
  const raw = `${JSON.stringify(store, null, 2)}\n`;
  await fs.writeFile(storePath, raw);
  expect(() => readLegacySessionStoreEntries({ storePath }, [])).toThrow(/2026\.9\.5/);
  expect(() => loadLegacySessionStore(storePath)).toThrow(/2026\.9\.5/);
  await expect(saveStore(store)).rejects.toThrow(/2026\.9\.5/);
  expect(await fs.readFile(storePath, "utf8")).toBe(raw);
});

it("imports provider-only fields still preserved by the July Doctor writer", async () => {
  await writeStore(mainStore({ provider: "slack", lastProvider: "telegram" }));
  const raw = await fs.readFile(storePath, "utf8");
  expectNormalized(loadLegacySessionStore(storePath), "telegram");
  expect(await fs.readFile(storePath, "utf8")).toBe(raw);
});

it("refuses a malformed UTF-8 legacy index without changing its bytes", async () => {
  const raw = Buffer.from(
    '{"agent:main:main":{"sessionId":"session-\xff","updatedAt":1}}',
    "latin1",
  );
  await fs.writeFile(storePath, raw);
  const issues: Parameters<typeof readLegacySessionStoreEntries>[1] = [];
  expect(readLegacySessionStoreEntries({ storePath }, issues)).toEqual({ entries: [] });
  expect(issues).toMatchObject([
    { code: "store_unreadable", message: expect.stringContaining("UTF-8") },
  ]);
  expect(await fs.readFile(storePath)).toEqual(raw);
});
