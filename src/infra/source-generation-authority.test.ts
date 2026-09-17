import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  assertSourceGenerationCurrent,
  isSourceGenerationCurrent,
} from "./source-generation-authority.js";

describe("source generation authority", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-source-generation-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects authority after the source session generation is replaced", async () => {
    const sessionKey = "agent:main:telegram:group:123:topic:155";
    await upsertSessionEntryCore(
      { agentId: "main", storePath, sessionKey },
      { sessionId: "source-session", lifecycleRevision: "revision-1", updatedAt: 1 },
    );
    const generation = {
      sessionKey,
      sessionId: "source-session",
      lifecycleRevision: "revision-1",
      sessionStore: storePath,
    };
    expect(isSourceGenerationCurrent(generation, "main")).toBe(true);
    expect(() => assertSourceGenerationCurrent(generation, "main")).not.toThrow();

    await upsertSessionEntryCore(
      { agentId: "main", storePath, sessionKey },
      { sessionId: "successor", lifecycleRevision: "revision-2", updatedAt: 2 },
    );
    expect(isSourceGenerationCurrent(generation, "main")).toBe(false);
    expect(() => assertSourceGenerationCurrent(generation, "main")).toThrow(
      "source session generation is no longer current",
    );
  });
});
