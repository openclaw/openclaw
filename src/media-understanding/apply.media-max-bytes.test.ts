import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "test-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
    if (auth?.apiKey) {
      return auth.apiKey;
    }
    throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`);
  },
}));

vi.mock("../media/fetch.js", () => ({
  fetchRemoteMedia: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
}));

async function loadApply() {
  return await import("./apply.js");
}

describe("applyMediaUnderstanding with MediaMaxBytes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mmb-"));
  });

  it("skips all media processing when MediaMaxBytes is 0", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const filePath = path.join(tmpDir, "doc.txt");
    await fs.writeFile(filePath, "Hello world content for testing");

    const ctx: MsgContext = {
      Body: "check this file",
      MediaPath: filePath,
      MediaType: "text/plain",
      MediaMaxBytes: 0,
    };
    const cfg: OpenClawConfig = {};

    const result = await applyMediaUnderstanding({ ctx, cfg });

    expect(result.appliedFile).toBe(false);
    expect(result.appliedImage).toBe(false);
    expect(result.appliedAudio).toBe(false);
    expect(result.appliedVideo).toBe(false);
    // Body should remain unchanged — no file content injected
    expect(ctx.Body).toBe("check this file");
  });

  it("injects file-too-large notice when file exceeds MediaMaxBytes", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    // Create a file larger than 100 bytes
    const filePath = path.join(tmpDir, "big-report.txt");
    const content = "A".repeat(200);
    await fs.writeFile(filePath, content);

    const ctx: MsgContext = {
      Body: "please review",
      MediaPath: filePath,
      MediaType: "text/plain",
      MediaMaxBytes: 100, // 100 bytes limit
    };
    const cfg: OpenClawConfig = {};

    const result = await applyMediaUnderstanding({ ctx, cfg });

    // The file block should be the "too large" notice, not the actual content
    expect(ctx.Body).toContain("[File too large: big-report.txt");
    expect(ctx.Body).toContain("exceeds limit of");
    // Should NOT contain the actual file content
    expect(ctx.Body).not.toContain("AAAA");
    expect(result.appliedFile).toBe(true);
  });

  it("allows file injection when file is within MediaMaxBytes", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const filePath = path.join(tmpDir, "small.txt");
    await fs.writeFile(filePath, "small content");

    const ctx: MsgContext = {
      Body: "check this",
      MediaPath: filePath,
      MediaType: "text/plain",
      MediaMaxBytes: 1024 * 1024, // 1MB — plenty of room
    };
    const cfg: OpenClawConfig = {};

    const result = await applyMediaUnderstanding({ ctx, cfg });

    // File content should be injected normally
    expect(ctx.Body).toContain("small content");
    expect(ctx.Body).not.toContain("[File too large");
    expect(result.appliedFile).toBe(true);
  });

  it("allows file injection when MediaMaxBytes is undefined (no limit)", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const filePath = path.join(tmpDir, "normal.txt");
    await fs.writeFile(filePath, "normal content here");

    const ctx: MsgContext = {
      Body: "read this",
      MediaPath: filePath,
      MediaType: "text/plain",
      // MediaMaxBytes is undefined — no channel-level limit
    };
    const cfg: OpenClawConfig = {};

    const result = await applyMediaUnderstanding({ ctx, cfg });

    expect(ctx.Body).toContain("normal content here");
    expect(result.appliedFile).toBe(true);
  });
});
