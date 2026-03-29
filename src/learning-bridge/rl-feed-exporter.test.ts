import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { clearConfigCache } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRlFeedRoot } from "./rl-feed-exporter.js";

describe("resolveRlFeedRoot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearConfigCache();
  });

  test("expands tilde in outputDir before state-dir containment check", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oc-rl-feed-"));
    const stateDir = path.join(home, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const expectedOut = path.join(stateDir, "rl-feed");
    await fs.mkdir(expectedOut, { recursive: true });

    vi.spyOn(os, "homedir").mockReturnValue(home);

    const root = await resolveRlFeedRoot({
      research: {
        learningBridge: {
          outputDir: "~/.openclaw/rl-feed",
        },
      },
    } as OpenClawConfig);

    expect(root).toBe(await fs.realpath(expectedOut));
  });
});
