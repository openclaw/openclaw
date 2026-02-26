import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempHomeEnv } from "./temp-home.js";

describe("createTempHomeEnv", () => {
  it("sets home env vars and restores them on cleanup", async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const leakedConfigPath = "/tmp/leaked-openclaw-config.json";

    process.env.OPENCLAW_CONFIG_PATH = leakedConfigPath;

    const tempHome = await createTempHomeEnv("openclaw-temp-home-");
    expect(process.env.HOME).toBe(tempHome.home);
    expect(process.env.USERPROFILE).toBe(tempHome.home);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(path.join(tempHome.home, ".openclaw"));
    expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
    await expect(fs.stat(tempHome.home)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });

    await tempHome.restore();

    expect(process.env.HOME).toBe(previousHome);
    expect(process.env.USERPROFILE).toBe(previousUserProfile);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
    expect(process.env.OPENCLAW_CONFIG_PATH).toBe(leakedConfigPath);
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    }
    await expect(fs.stat(tempHome.home)).rejects.toThrow();
  });
});
