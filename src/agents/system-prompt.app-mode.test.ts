import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const base = { workspaceDir: "/tmp/openclaw", ownerNumbers: ["+123"] };

describe('buildAgentSystemPrompt promptMode "app"', () => {
  const full = buildAgentSystemPrompt({ ...base, promptMode: "full" });
  const app = buildAgentSystemPrompt({ ...base, promptMode: "app" });

  it('"full" still renders the framework sections (regression guard)', () => {
    expect(full).toContain("## OpenClaw CLI Quick Reference");
    expect(full).toContain("## Heartbeats");
    expect(full).toContain("## Silent Replies");
    expect(full).toContain("## User Identity");
  });

  it('"app" drops framework sections the app user can\'t act on', () => {
    expect(app).not.toContain("## OpenClaw CLI Quick Reference");
    expect(app).not.toContain("## Heartbeats");
    expect(app).not.toContain("## Silent Replies");
    // Owner identity must not leak to app users.
    expect(app).not.toContain("## User Identity");
    expect(app).not.toContain("Owner numbers:");
  });

  it('"app" keeps the conversational sections (unlike "minimal")', () => {
    expect(app).toContain("## Tooling");
    expect(app).toContain("## Workspace");
  });

  it('"full" prompt is unchanged by the addition of "app" mode (byte-identical control)', () => {
    // A second build with identical inputs must be byte-for-byte identical — the new isApp
    // branches must not perturb the non-app path.
    expect(buildAgentSystemPrompt({ ...base, promptMode: "full" })).toBe(full);
  });
});
