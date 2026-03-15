import { describe, expect, it } from "vitest";
import {
  detectDockerEnvironment,
  detectDockerSocket,
  detectIsDocker,
  parseImageRef,
} from "./docker-detect.js";

describe("parseImageRef", () => {
  it("splits repo and tag", () => {
    expect(parseImageRef("ghcr.io/openclaw/openclaw:1.2.3")).toEqual({
      repo: "ghcr.io/openclaw/openclaw",
      tag: "1.2.3",
    });
  });

  it("handles latest tag", () => {
    expect(parseImageRef("ghcr.io/openclaw/openclaw:latest")).toEqual({
      repo: "ghcr.io/openclaw/openclaw",
      tag: "latest",
    });
  });

  it("returns null tag when no tag present", () => {
    expect(parseImageRef("ghcr.io/openclaw/openclaw")).toEqual({
      repo: "ghcr.io/openclaw/openclaw",
      tag: null,
    });
  });

  it("handles digest references", () => {
    expect(parseImageRef("ghcr.io/openclaw/openclaw@sha256:abc123")).toEqual({
      repo: "ghcr.io/openclaw/openclaw",
      tag: null,
    });
  });

  it("handles empty string", () => {
    expect(parseImageRef("")).toEqual({ repo: "", tag: null });
  });

  it("handles beta tag", () => {
    expect(parseImageRef("ghcr.io/openclaw/openclaw:1.0.0-beta.1")).toEqual({
      repo: "ghcr.io/openclaw/openclaw",
      tag: "1.0.0-beta.1",
    });
  });

  it("handles registry with port and tag", () => {
    expect(parseImageRef("registry.example.com:5000/repo:tag")).toEqual({
      repo: "registry.example.com:5000/repo",
      tag: "tag",
    });
  });

  it("handles registry with port and no tag", () => {
    expect(parseImageRef("registry.example.com:5000/org/repo")).toEqual({
      repo: "registry.example.com:5000/org/repo",
      tag: null,
    });
  });

  it("handles registry with port, nested path, and tag", () => {
    expect(parseImageRef("myregistry.io:443/org/suborg/image:v2.0.0")).toEqual({
      repo: "myregistry.io:443/org/suborg/image",
      tag: "v2.0.0",
    });
  });
});

describe("detectIsDocker", () => {
  it("returns true when OPENCLAW_DOCKER=1", async () => {
    expect(await detectIsDocker({ OPENCLAW_DOCKER: "1" })).toBe(true);
  });

  it("returns true when OPENCLAW_DOCKER=true", async () => {
    expect(await detectIsDocker({ OPENCLAW_DOCKER: "true" })).toBe(true);
  });

  it("returns false when OPENCLAW_DOCKER=0", async () => {
    expect(await detectIsDocker({ OPENCLAW_DOCKER: "0" })).toBe(false);
  });

  it("returns false when OPENCLAW_DOCKER=false", async () => {
    expect(await detectIsDocker({ OPENCLAW_DOCKER: "false" })).toBe(false);
  });
});

describe("detectDockerSocket", () => {
  it("returns false for non-existent path", async () => {
    expect(await detectDockerSocket("/nonexistent/socket.sock")).toBe(false);
  });
});

describe("detectDockerEnvironment", () => {
  it("returns non-Docker environment when OPENCLAW_DOCKER=0", async () => {
    const env = { OPENCLAW_DOCKER: "0" };
    const result = await detectDockerEnvironment(env);
    expect(result.isDocker).toBe(false);
    expect(result.hasDockerSocket).toBe(false);
    expect(result.currentImage).toBeNull();
    expect(result.currentTag).toBeNull();
    expect(result.imageRepo).toBeNull();
  });

  it("detects Docker with explicit image", async () => {
    const env = {
      OPENCLAW_DOCKER: "1",
      OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:1.2.3",
    };
    const result = await detectDockerEnvironment(env);
    expect(result.isDocker).toBe(true);
    expect(result.currentImage).toBe("ghcr.io/openclaw/openclaw:1.2.3");
    expect(result.currentTag).toBe("1.2.3");
    expect(result.imageRepo).toBe("ghcr.io/openclaw/openclaw");
  });

  it("uses default image repo when no OPENCLAW_IMAGE", async () => {
    const env = { OPENCLAW_DOCKER: "1" };
    const result = await detectDockerEnvironment(env);
    expect(result.isDocker).toBe(true);
    expect(result.imageRepo).toBe("ghcr.io/openclaw/openclaw");
    expect(result.currentTag).toBeNull();
  });

  it("respects OPENCLAW_IMAGE_TAG override", async () => {
    const env = {
      OPENCLAW_DOCKER: "1",
      OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:latest",
      OPENCLAW_IMAGE_TAG: "1.5.0",
    };
    const result = await detectDockerEnvironment(env);
    expect(result.currentTag).toBe("1.5.0");
    expect(result.currentImage).toBe("ghcr.io/openclaw/openclaw:1.5.0");
  });
});
