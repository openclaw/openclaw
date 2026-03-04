import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultMediaLocalRoots } from "./local-roots.js";

describe("getDefaultMediaLocalRoots", () => {
  const originalProfile = process.env.OPENCLAW_PROFILE;

  beforeEach(() => {
    delete process.env.OPENCLAW_PROFILE;
  });

  afterEach(() => {
    if (originalProfile === undefined) {
      delete process.env.OPENCLAW_PROFILE;
    } else {
      process.env.OPENCLAW_PROFILE = originalProfile;
    }
  });

  it("includes default workspace directory", () => {
    const roots = getDefaultMediaLocalRoots();
    const hasWorkspace = roots.some((r) => r.endsWith(`${path.sep}workspace`) || r.endsWith("/workspace"));
    expect(hasWorkspace).toBe(true);
  });

  it("includes profile-specific workspace when OPENCLAW_PROFILE is set", () => {
    process.env.OPENCLAW_PROFILE = "testprofile";
    const roots = getDefaultMediaLocalRoots();
    const hasProfileWorkspace = roots.some(
      (r) => r.includes("workspace-testprofile"),
    );
    expect(hasProfileWorkspace).toBe(true);
  });

  it("does not duplicate workspace for default profile", () => {
    process.env.OPENCLAW_PROFILE = "default";
    const roots = getDefaultMediaLocalRoots();
    const workspaceRoots = roots.filter((r) => r.includes("workspace"));
    expect(workspaceRoots.length).toBe(1);
  });
});
