import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt,
  updateSessionStoreEntry,
  upsertSessionEntry,
} from "./session-store-runtime.js";

describe("session-store-runtime compatibility surface", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-session-store-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps the public session read shape while using accessor-backed exports", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 10,
    });
    expect(readSessionUpdatedAt({ sessionKey, storePath })).toEqual(expect.any(Number));
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey,
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "session-1",
          updatedAt: 10,
        }),
      },
    ]);

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 20,
      },
    });
    expect(getSessionEntry({ sessionKey, storePath })?.model).toBeUndefined();
  });

  it("keeps the public entry mutation signature while delegating to the seam", async () => {
    const sessionKey = "agent:main:main";

    await expect(
      updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toBeNull();

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    const beforePatch = getSessionEntry({ sessionKey, storePath });
    await expect(
      patchSessionEntry({
        sessionKey,
        storePath,
        preserveActivity: true,
        update: (_entry, context) => ({
          providerOverride: context.existingEntry ? "openai" : "missing",
          updatedAt: 20,
        }),
      }),
    ).resolves.toMatchObject({
      providerOverride: "openai",
      sessionId: "session-1",
      updatedAt: beforePatch?.updatedAt,
    });

    await expect(
      updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      providerOverride: "openai",
      sessionId: "session-1",
    });
  });
});
