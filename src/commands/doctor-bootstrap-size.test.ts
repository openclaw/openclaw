import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as piEmbeddedHelpers from "../agents/pi-embedded-helpers.js";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveBootstrapContextForRun = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
}));

vi.mock("../agents/bootstrap-files.js", () => ({
  resolveBootstrapContextForRun,
}));

import { noteBootstrapFileSize } from "./doctor-bootstrap-size.js";

describe("noteBootstrapFileSize", () => {
  let resolveBootstrapMaxCharsSpy: ReturnType<typeof vi.spyOn>;
  let resolveBootstrapTotalMaxCharsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    note.mockClear();
    resolveBootstrapContextForRun.mockReset();
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [],
      contextFiles: [],
    });
    resolveBootstrapMaxCharsSpy = vi
      .spyOn(piEmbeddedHelpers, "resolveBootstrapMaxChars")
      .mockReturnValue(20_000);
    resolveBootstrapTotalMaxCharsSpy = vi
      .spyOn(piEmbeddedHelpers, "resolveBootstrapTotalMaxChars")
      .mockReturnValue(150_000);
  });

  afterEach(() => {
    resolveBootstrapMaxCharsSpy.mockRestore();
    resolveBootstrapTotalMaxCharsSpy.mockRestore();
  });

  it("emits a warning when bootstrap files are truncated", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(25_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(20_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] ?? [];
    expect(String(title)).toBe("Bootstrap file size");
    expect(String(message)).toContain("will be truncated");
    expect(String(message)).toContain("AGENTS.md");
    expect(String(message)).toContain("max/file");
  });

  it("stays silent when files are comfortably within limits", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(1_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(1_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).not.toHaveBeenCalled();
  });
});
