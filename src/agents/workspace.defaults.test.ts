import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("DEFAULT_AGENT_WORKSPACE_DIR", () => {
  it("uses EASYHUB_HOME at module import time", async () => {
    const home = path.join(path.sep, "srv", "EasyHub-home");
    vi.stubEnv("EASYHUB_HOME", home);
    vi.stubEnv("HOME", path.join(path.sep, "home", "other"));
    vi.resetModules();

    const mod = await import("./workspace.js");
    expect(mod.DEFAULT_AGENT_WORKSPACE_DIR).toBe(
      path.join(path.resolve(home), ".easyhub", "workspace"),
    );
  });
});
