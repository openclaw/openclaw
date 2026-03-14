import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCortexModeOverride,
  getCortexModeOverride,
  setCortexModeOverride,
} from "./cortex-mode-overrides.js";

describe("cortex mode overrides", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createStorePath() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-mode-"));
    tempDirs.push(dir);
    return path.join(dir, "cortex-mode-overrides.json");
  }

  it("prefers session overrides over channel overrides", async () => {
    const pathname = await createStorePath();
    await setCortexModeOverride({
      pathname,
      agentId: "main",
      scope: "channel",
      targetId: "slack",
      mode: "professional",
    });
    await setCortexModeOverride({
      pathname,
      agentId: "main",
      scope: "session",
      targetId: "session-1",
      mode: "minimal",
    });

    const resolved = await getCortexModeOverride({
      pathname,
      agentId: "main",
      sessionId: "session-1",
      channelId: "slack",
    });

    expect(resolved?.mode).toBe("minimal");
    expect(resolved?.scope).toBe("session");
  });

  it("can clear a stored override", async () => {
    const pathname = await createStorePath();
    await setCortexModeOverride({
      pathname,
      agentId: "main",
      scope: "channel",
      targetId: "telegram",
      mode: "minimal",
    });

    const removed = await clearCortexModeOverride({
      pathname,
      agentId: "main",
      scope: "channel",
      targetId: "telegram",
    });

    const resolved = await getCortexModeOverride({
      pathname,
      agentId: "main",
      channelId: "telegram",
    });

    expect(removed).toBe(true);
    expect(resolved).toBeNull();
  });
});
