import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/workspace/test-agent"),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: vi.fn(() => "/state"),
}));

vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp/openclaw"),
}));

vi.mock("./inbound-path-policy.js", () => ({
  resolveIMessageAttachmentRoots: vi.fn(() => []),
}));

import type { OpenClawConfig } from "../config/config.js";
import { resolveIMessageAttachmentRoots } from "./inbound-path-policy.js";
import { getAgentScopedMediaLocalRoots } from "./local-roots.js";

const mockedResolveIMessageAttachmentRoots = vi.mocked(resolveIMessageAttachmentRoots);

describe("getAgentScopedMediaLocalRoots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes iMessage attachment roots when iMessage is configured", () => {
    const cfg = {
      channels: {
        imessage: {
          attachmentRoots: ["/Users/test/Library/Messages/Attachments"],
        },
      },
    } as unknown as OpenClawConfig;

    mockedResolveIMessageAttachmentRoots.mockReturnValue([
      "/Users/test/Library/Messages/Attachments",
    ]);

    const roots = getAgentScopedMediaLocalRoots(cfg, "test-agent");
    expect(roots).toContain("/Users/test/Library/Messages/Attachments");
    expect(mockedResolveIMessageAttachmentRoots).toHaveBeenCalledWith({ cfg });
  });

  it("does not duplicate roots when iMessage roots overlap with defaults", () => {
    const cfg = {} as unknown as OpenClawConfig;
    mockedResolveIMessageAttachmentRoots.mockReturnValue(["/tmp/openclaw"]);

    const roots = getAgentScopedMediaLocalRoots(cfg, "test-agent");
    const occurrences = roots.filter((r) => r === "/tmp/openclaw").length;
    expect(occurrences).toBe(1);
  });

  it("returns default roots when iMessage is not configured", () => {
    const cfg = {} as unknown as OpenClawConfig;
    mockedResolveIMessageAttachmentRoots.mockReturnValue([]);

    const roots = getAgentScopedMediaLocalRoots(cfg, "test-agent");
    expect(roots).not.toContain("/Users/test/Library/Messages/Attachments");
  });

  it("returns base roots when agentId is undefined", () => {
    const cfg = {} as unknown as OpenClawConfig;
    mockedResolveIMessageAttachmentRoots.mockReturnValue([]);

    const roots = getAgentScopedMediaLocalRoots(cfg);
    // Should still contain the base media roots (tmp, media, agents, workspace, sandboxes)
    expect(roots.length).toBeGreaterThanOrEqual(5);
  });

  it("returns base roots when agentId is empty string", () => {
    const cfg = {} as unknown as OpenClawConfig;
    mockedResolveIMessageAttachmentRoots.mockReturnValue([]);

    const roots = getAgentScopedMediaLocalRoots(cfg, "  ");
    expect(roots.length).toBeGreaterThanOrEqual(5);
  });
});
