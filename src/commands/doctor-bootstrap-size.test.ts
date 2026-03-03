import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { noteBootstrapFileSize } from "./doctor-bootstrap-size.js";

// Mock the note function to capture output
vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

const { note } = await import("../terminal/note.js");
const noteMock = vi.mocked(note);

function buildConfig(overrides?: {
  bootstrapMaxChars?: number;
  bootstrapTotalMaxChars?: number;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        bootstrapMaxChars: overrides?.bootstrapMaxChars,
        bootstrapTotalMaxChars: overrides?.bootstrapTotalMaxChars,
      },
    },
  } as unknown as OpenClawConfig;
}

describe("noteBootstrapFileSize", () => {
  let tmpDir: string;

  afterEach(async () => {
    noteMock.mockClear();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not warn when all files are within limits", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-"));
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "Short content");

    await noteBootstrapFileSize(buildConfig(), tmpDir);

    expect(noteMock).not.toHaveBeenCalled();
  });

  it("warns when a file exceeds per-file limit", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-"));
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "x".repeat(500));

    await noteBootstrapFileSize(buildConfig({ bootstrapMaxChars: 100 }), tmpDir);

    expect(noteMock).toHaveBeenCalledOnce();
    const output = noteMock.mock.calls[0]?.[0];
    expect(output).toContain("AGENTS.md");
    expect(output).toContain("truncated");
  });

  it("warns when total exceeds total limit", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-"));
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "x".repeat(300));
    await fs.writeFile(path.join(tmpDir, "SOUL.md"), "y".repeat(300));

    await noteBootstrapFileSize(
      buildConfig({ bootstrapMaxChars: 1000, bootstrapTotalMaxChars: 400 }),
      tmpDir,
    );

    expect(noteMock).toHaveBeenCalledOnce();
    const output = noteMock.mock.calls[0]?.[0];
    expect(output).toContain("Total:");
    expect(output).toContain("lost");
  });

  it("skips when no workspace dir provided", async () => {
    await noteBootstrapFileSize(buildConfig());
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("skips missing files without error", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-"));

    await noteBootstrapFileSize(buildConfig(), tmpDir);

    expect(noteMock).not.toHaveBeenCalled();
  });

  it("shows config hint when using default per-file limit", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-"));
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "x".repeat(25_000));

    await noteBootstrapFileSize(buildConfig(), tmpDir);

    expect(noteMock).toHaveBeenCalledOnce();
    const output = noteMock.mock.calls[0]?.[0];
    expect(output).toContain("bootstrapMaxChars");
  });
});
