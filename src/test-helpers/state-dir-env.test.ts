import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  restoreStateDirEnv,
  setStateDirEnv,
  snapshotStateDirEnv,
  withStateDirEnv,
} from "./state-dir-env.js";

describe("state-dir-env helpers", () => {
  it("set/snapshot/restore round-trips OPENCLAW_STATE_DIR", () => {
    const prevOpenClaw = process.env.OPENCLAW_STATE_DIR;
    const prevLegacy = process.env.CLAWDBOT_STATE_DIR;
    const snapshot = snapshotStateDirEnv();

    setStateDirEnv("/tmp/openclaw-state-dir-test");
    expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-state-dir-test");
    expect(process.env.CLAWDBOT_STATE_DIR).toBeUndefined();

    restoreStateDirEnv(snapshot);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(prevOpenClaw);
    expect(process.env.CLAWDBOT_STATE_DIR).toBe(prevLegacy);
  });

  it("withStateDirEnv sets env for callback and cleans up temp root", async () => {
    const prevOpenClaw = process.env.OPENCLAW_STATE_DIR;
    const prevLegacy = process.env.CLAWDBOT_STATE_DIR;

    let capturedTempRoot = "";
    let capturedStateDir = "";
    await withStateDirEnv("openclaw-state-dir-env-", async ({ tempRoot, stateDir }) => {
      capturedTempRoot = tempRoot;
      capturedStateDir = stateDir;
      expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
      expect(process.env.CLAWDBOT_STATE_DIR).toBeUndefined();
      await fs.writeFile(path.join(stateDir, "probe.txt"), "ok", "utf8");
    });

    expect(process.env.OPENCLAW_STATE_DIR).toBe(prevOpenClaw);
    expect(process.env.CLAWDBOT_STATE_DIR).toBe(prevLegacy);
    await expect(fs.stat(capturedStateDir)).rejects.toThrow();
    await expect(fs.stat(capturedTempRoot)).rejects.toThrow();
  });

  it("withStateDirEnv restores env and cleans temp root when callback throws", async () => {
    const prevOpenClaw = process.env.OPENCLAW_STATE_DIR;
    const prevLegacy = process.env.CLAWDBOT_STATE_DIR;

    let capturedTempRoot = "";
    let capturedStateDir = "";
    await expect(
      withStateDirEnv("openclaw-state-dir-env-", async ({ tempRoot, stateDir }) => {
        capturedTempRoot = tempRoot;
        capturedStateDir = stateDir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(process.env.OPENCLAW_STATE_DIR).toBe(prevOpenClaw);
    expect(process.env.CLAWDBOT_STATE_DIR).toBe(prevLegacy);
    await expect(fs.stat(capturedStateDir)).rejects.toThrow();
    await expect(fs.stat(capturedTempRoot)).rejects.toThrow();
  });
});
