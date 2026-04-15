import { describe, expect, it } from "vitest";
import { resolveOpenClawGitHubRuntimeObject } from "./shared.js";

describe("resolveOpenClawGitHubRuntimeObject", () => {
  it("uses the default repository when no override is set", () => {
    const runtime = resolveOpenClawGitHubRuntimeObject({});
    expect(runtime.repo).toBe("openclaw/openclaw");
    expect(runtime.cloneUrl).toBe("https://github.com/openclaw/openclaw.git");
    expect(runtime.webUrl).toBe("https://github.com/openclaw/openclaw");
  });

  it("uses a valid OPENCLAW_GITHUB_REPO override", () => {
    const runtime = resolveOpenClawGitHubRuntimeObject({
      OPENCLAW_GITHUB_REPO: "benholl94-cmyk/XopenclawX",
    });
    expect(runtime.repo).toBe("benholl94-cmyk/XopenclawX");
    expect(runtime.cloneUrl).toBe("https://github.com/benholl94-cmyk/XopenclawX.git");
    expect(runtime.webUrl).toBe("https://github.com/benholl94-cmyk/XopenclawX");
    expect(runtime.bootstrapCommand).toContain(
      "git clone https://github.com/benholl94-cmyk/XopenclawX.git",
    );
  });

  it("ignores malformed OPENCLAW_GITHUB_REPO overrides", () => {
    const runtime = resolveOpenClawGitHubRuntimeObject({
      OPENCLAW_GITHUB_REPO: "https://github.com/openclaw/openclaw",
    });
    expect(runtime.repo).toBe("openclaw/openclaw");
  });

  it("rejects unsupported owner formats", () => {
    const runtime = resolveOpenClawGitHubRuntimeObject({
      OPENCLAW_GITHUB_REPO: "owner.with.dot/XopenclawX",
    });
    expect(runtime.repo).toBe("openclaw/openclaw");
  });
});
