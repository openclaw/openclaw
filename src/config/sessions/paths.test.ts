import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStorePath } from "./paths.js";

describe("resolveStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses EASYHUB_HOME for tilde expansion", () => {
    vi.stubEnv("EASYHUB_HOME", "/srv/EasyHub-home");
    vi.stubEnv("HOME", "/home/other");

    const resolved = resolveStorePath("~/.easyhub/agents/{agentId}/sessions/sessions.json", {
      agentId: "research",
    });

    expect(resolved).toBe(
      path.resolve("/srv/EasyHub-home/.easyhub/agents/research/sessions/sessions.json"),
    );
  });
});
