import { describe, it, expect } from "vitest";
import {
  normalizeControlUiBasePath,
  buildControlUiAvatarUrl,
  resolveAssistantAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
} from "./control-ui-shared.js";

describe("CONTROL_UI_AVATAR_PREFIX", () => {
  it("should be /avatar", () => {
    expect(CONTROL_UI_AVATAR_PREFIX).toBe("/avatar");
  });
});

describe("normalizeControlUiBasePath", () => {
  it("should return empty string for undefined", () => {
    expect(normalizeControlUiBasePath(undefined)).toBe("");
  });

  it("should return empty string for empty string", () => {
    expect(normalizeControlUiBasePath("")).toBe("");
  });

  it("should return empty string for whitespace", () => {
    expect(normalizeControlUiBasePath("   ")).toBe("");
  });

  it("should add leading slash if missing", () => {
    expect(normalizeControlUiBasePath("api")).toBe("/api");
  });

  it("should keep leading slash if present", () => {
    expect(normalizeControlUiBasePath("/api")).toBe("/api");
  });

  it("should remove trailing slash", () => {
    expect(normalizeControlUiBasePath("/api/")).toBe("/api");
  });

  it("should return empty string for root path", () => {
    expect(normalizeControlUiBasePath("/")).toBe("");
  });

  it("should trim whitespace", () => {
    expect(normalizeControlUiBasePath("  /api/  ")).toBe("/api");
  });

  it("should handle nested paths", () => {
    expect(normalizeControlUiBasePath("/api/v1/")).toBe("/api/v1");
  });
});

describe("buildControlUiAvatarUrl", () => {
  it("should build URL without base path", () => {
    expect(buildControlUiAvatarUrl("", "agent-123")).toBe("/avatar/agent-123");
  });

  it("should build URL with base path", () => {
    expect(buildControlUiAvatarUrl("/api", "agent-123")).toBe("/api/avatar/agent-123");
  });

  it("should handle agent ID with special characters", () => {
    expect(buildControlUiAvatarUrl("/api", "agent_123-test")).toBe("/api/avatar/agent_123-test");
  });
});

describe("resolveAssistantAvatarUrl", () => {
  it("should return undefined for empty avatar", () => {
    expect(resolveAssistantAvatarUrl({})).toBeUndefined();
  });

  it("should return undefined for whitespace avatar", () => {
    expect(resolveAssistantAvatarUrl({ avatar: "   " })).toBeUndefined();
  });

  it("should return HTTP URL as-is", () => {
    const url = "https://example.com/avatar.png";
    expect(resolveAssistantAvatarUrl({ avatar: url })).toBe(url);
  });

  it("should return data URL as-is", () => {
    const url = "data:image/png;base64,abc123";
    expect(resolveAssistantAvatarUrl({ avatar: url })).toBe(url);
  });

  it("should prepend base path to avatar path without base path", () => {
    expect(resolveAssistantAvatarUrl({
      avatar: "/avatar/agent-123",
      basePath: "/api",
    })).toBe("/api/avatar/agent-123");
  });

  it("should keep avatar path with matching base path", () => {
    expect(resolveAssistantAvatarUrl({
      avatar: "/api/avatar/agent-123",
      basePath: "/api",
    })).toBe("/api/avatar/agent-123");
  });

  it("should return avatar as-is when it looks like avatar path", () => {
    expect(resolveAssistantAvatarUrl({
      avatar: "/avatar/agent-123",
      agentId: "agent-123",
    })).toBe("/avatar/agent-123");
  });

  it("should build avatar URL when avatar looks like path and agentId provided", () => {
    expect(resolveAssistantAvatarUrl({
      avatar: "default-avatar",
      agentId: "agent-123",
    })).toBe("/avatar/agent-123");
  });

  it("should return avatar as-is when no agentId", () => {
    expect(resolveAssistantAvatarUrl({
      avatar: "custom-avatar",
    })).toBe("custom-avatar");
  });

  it("should trim avatar whitespace", () => {
    expect(resolveAssistantAvatarUrl({
      avatar: "  https://example.com/avatar.png  ",
    })).toBe("https://example.com/avatar.png");
  });

  it("should handle base path normalization", () => {
    expect(resolveAssistantAvatarUrl({
      avatar: "/avatar/agent-123",
      basePath: "api/",
      agentId: "agent-123",
    })).toBe("/api/avatar/agent-123");
  });
});
