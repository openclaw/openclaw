import type { MakeDirectoryOptions, Mode, PathLike } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  loadLegacySessionStore,
  saveLegacySessionStore,
} from "./state-migrations.legacy-session-store.js";
import { resolveStaleLegacySessionFile } from "./state-migrations.session-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

it.each([
  { modelRunPruneAfterMs: DAY_MS, modelRunSessionPresent: false },
  { modelRunPruneAfterMs: 0, modelRunSessionPresent: true },
  { modelRunPruneAfterMs: -DAY_MS, modelRunSessionPresent: true },
])(
  "applies model-run retention $modelRunPruneAfterMs during legacy maintenance",
  async ({ modelRunPruneAfterMs, modelRunSessionPresent }) => {
    await withTestDir({ prefix: "openclaw-legacy-session-maintenance-" }, async (root) => {
      const storePath = path.join(root, "sessions.json");
      const modelRunSessionKey =
        "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
      const now = Date.now();
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [modelRunSessionKey]: { sessionId: "session-model-run", updatedAt: now - 2 * DAY_MS },
          "agent:main:old": { sessionId: "session-old", updatedAt: now - 3 * DAY_MS },
          "agent:main:active": { sessionId: "session-active", updatedAt: now },
        }),
      );

      const store = loadLegacySessionStore(storePath, {
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

      expect(store[modelRunSessionKey] != null).toBe(modelRunSessionPresent);
      expect(Object.keys(store)).toHaveLength(modelRunSessionPresent ? 3 : 2);
      expect(Object.values(store).filter((entry) => entry.archivedAt === undefined)).toHaveLength(
        2,
      );
      expect(store["agent:main:active"]).toMatchObject({ sessionId: "session-active" });
      expect(store["agent:main:active"]?.archivedAt).toBeUndefined();
      expect(store["agent:main:old"]).toMatchObject({ sessionId: "session-old" });
      if (modelRunSessionPresent) {
        expect(store[modelRunSessionKey]).toMatchObject({ sessionId: "session-model-run" });
        expect(store[modelRunSessionKey]?.archivedAt).toBeUndefined();
        expect(store["agent:main:old"]?.archivedAt).toEqual(expect.any(Number));
      } else {
        expect(store["agent:main:old"]?.archivedAt).toBeUndefined();
      }
    });
  },
);

it("does not treat archived rows as legacy maintenance pressure", async () => {
  await withTestDir({ prefix: "openclaw-legacy-session-maintenance-" }, async (root) => {
    const storePath = path.join(root, "sessions.json");
    const modelRunSessionKey = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const now = Date.now();
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [modelRunSessionKey]: { sessionId: "session-model-run", updatedAt: now - 2 * DAY_MS },
        "agent:main:active": { sessionId: "session-active", updatedAt: now },
        "agent:main:archived": {
          archivedAt: now - DAY_MS,
          sessionId: "session-archived",
          updatedAt: now - 3 * DAY_MS,
        },
      }),
    );

    const store = loadLegacySessionStore(storePath, {
      runMaintenance: true,
      maintenanceConfig: {
        mode: "enforce",
        pruneAfterMs: 30 * DAY_MS,
        archiveDashboardAfterMs: null,
        modelRunPruneAfterMs: DAY_MS,
        maxEntries: 2,
        preserveRecentMs: null,
        resetArchiveRetentionMs: null,
        maxDiskBytes: null,
        highWaterBytes: null,
      },
    });

    expect(store[modelRunSessionKey]).toBeDefined();
    expect(store["agent:main:archived"]?.archivedAt).toBe(now - DAY_MS);
  });
});

it("stages prompt blobs after a recreated session directory", async () => {
  await withTestDir({ prefix: "openclaw-legacy-session-store-" }, async (root) => {
    const storeDir = path.join(root, "sessions");
    const storePath = path.join(storeDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const prompt = `<available_skills>\n${"recreated dir prompt\n".repeat(200)}</available_skills>`;
    const realMkdir = fs.mkdir.bind(fs);
    let storeDirMkdirs = 0;
    const mkdirSpy = vi
      .spyOn(fs, "mkdir")
      .mockImplementation(
        async (dirPath: PathLike, options?: MakeDirectoryOptions | Mode | null) => {
          if (typeof dirPath === "string" && path.resolve(dirPath) === path.resolve(storeDir)) {
            storeDirMkdirs += 1;
            if (storeDirMkdirs === 2) {
              await fs.rm(storeDir, { force: true, recursive: true });
            }
          }
          return await realMkdir(dirPath, options ?? undefined);
        },
      );

    try {
      await saveLegacySessionStore(
        storePath,
        {
          [sessionKey]: {
            sessionId: "session-1",
            updatedAt: 1,
            skillsSnapshot: {
              prompt,
              skills: [{ name: "demo" }],
              version: 1,
            },
          },
        },
        { skipMaintenance: true },
      );
    } finally {
      mkdirSpy.mockRestore();
    }

    expect(storeDirMkdirs).toBeGreaterThanOrEqual(2);
    expect(loadLegacySessionStore(storePath)[sessionKey]?.skillsSnapshot?.prompt).toBe(prompt);
  });
});

it("normalizes file-era rows and drops malformed entries", async () => {
  await withTestDir({ prefix: "openclaw-legacy-session-normalize-" }, async (root) => {
    const storePath = path.join(root, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        malformed: null,
        "agent:main:main": {
          sessionId: " session-1 ",
          updatedAt: 1,
          provider: "slack",
          lastProvider: "telegram",
          pendingFinalDeliveryAttemptCount: -1,
          pluginExtensions: {
            " demo ": {
              " valid ": { ok: true },
              invalid: undefined,
            },
          },
        },
      }),
    );

    const store = loadLegacySessionStore(storePath);

    expect(store.malformed).toBeUndefined();
    expect(store["agent:main:main"]).toMatchObject({
      sessionId: "session-1",
      delivery: {
        kind: "external",
        context: { channel: "telegram" },
        origin: { provider: "telegram" },
      },
      pluginExtensions: { demo: { valid: { ok: true } } },
    });
    expect(store["agent:main:main"]).not.toHaveProperty("channel");
    expect(store["agent:main:main"]).not.toHaveProperty("lastChannel");
    expect(store["agent:main:main"]).not.toHaveProperty("pendingFinalDeliveryAttemptCount");
  });
});

it("normalizes compatibility writes before persistence", async () => {
  await withTestDir({ prefix: "openclaw-legacy-session-write-" }, async (root) => {
    const storePath = path.join(root, "sessions.json");
    const store = {
      malformed: null,
      "agent:main:main": {
        sessionId: " session-1 ",
        updatedAt: 1,
        provider: "slack",
        pendingFinalDeliveryAttemptCount: -1,
        skillsSnapshot: {
          prompt: "compact skill prompt",
          skills: [{ name: "demo" }],
          skillFilter: ["demo"],
          resolvedSkills: [{ name: "demo", description: "runtime-only catalog" }],
          version: 7,
        },
      },
    } as unknown as Parameters<typeof saveLegacySessionStore>[1];

    await saveLegacySessionStore(storePath, store, { skipMaintenance: true });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(persisted.malformed).toBeUndefined();
    expect(persisted["agent:main:main"]).toMatchObject({
      sessionId: "session-1",
      delivery: {
        kind: "external",
        context: { channel: "slack" },
        origin: { provider: "slack" },
      },
      skillsSnapshot: {
        prompt: "compact skill prompt",
        skills: [{ name: "demo" }],
        skillFilter: ["demo"],
        version: 7,
      },
    });
    expect(persisted["agent:main:main"]).not.toHaveProperty("channel");
    expect(persisted["agent:main:main"]).not.toHaveProperty("pendingFinalDeliveryAttemptCount");
    expect(persisted["agent:main:main"]?.skillsSnapshot).not.toHaveProperty("resolvedSkills");
  });
});

it("repairs a stale session file whose header straddles the read chunk boundary", async () => {
  await withTestDir({ prefix: "openclaw-legacy-session-header-boundary-" }, async (root) => {
    const sessionId = "sess-boundary-1";
    const legacyDir = path.join(root, "legacy-sessions");
    const targetDir = path.join(root, "sessions");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.mkdir(targetDir, { recursive: true });

    // Build a header whose single JSON line is longer than one 8192-byte read
    // chunk and whose 3-byte CJK character begins at offset 8191, so it is split
    // across the chunk boundary. Decoding a fixed window with `toString("utf8")`
    // replaces the split character with U+FFFD and the header stops parsing.
    const buildHeader = (): Buffer => {
      const prefix = Buffer.from(`{"type":"session","id":"${sessionId}","pad":"`, "utf8");
      const pad = Buffer.from("a".repeat(8191 - prefix.length), "utf8");
      return Buffer.concat([prefix, pad, Buffer.from("中", "utf8"), Buffer.from('"}\n', "utf8")]);
    };

    const legacySessionFile = path.join(legacyDir, `${sessionId}.jsonl`);
    const targetSessionFile = path.join(targetDir, `${sessionId}.jsonl`);
    // The legacy path must be gone; only the target copy exists. The repair then
    // checks that the target header names this same session before adopting it.
    await fs.writeFile(targetSessionFile, buildHeader());

    expect(
      resolveStaleLegacySessionFile({
        entry: { sessionId, sessionFile: legacySessionFile },
        legacyDir,
        targetDir,
      }),
    ).toBe(targetSessionFile);
  });
});
