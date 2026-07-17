// Covers default-agent transcript path resolution.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../types.js";
import { resolveSessionTranscriptsDir } from "./paths.js";

describe("resolveSessionTranscriptsDir", () => {
  it("uses the configured default agent instead of hardcoded main when config is provided", () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" };
    const cfg = {
      agents: {
        list: [{ id: "utility" }, { id: "nova", default: true }],
      },
    } satisfies OpenClawConfig;

    expect(resolveSessionTranscriptsDir(env, () => "/home/tester", cfg)).toBe(
      path.join("/tmp/openclaw-state", "agents", "nova", "sessions"),
    );
  });
});
