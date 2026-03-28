import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionTranscriptFile } from "./sessions.js";

const FAKE_WORKSPACE = "/home/node/.openclaw/workspaces/chief";

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "chief"),
  resolveAgentWorkspaceDir: vi.fn(() => FAKE_WORKSPACE),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

describe("ensureSessionTranscriptFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes agent workspace dir as cwd, not process.cwd()", () => {
    const sessionId = "test-session-001";
    const result = ensureSessionTranscriptFile({
      cfg: {} as never,
      sessionId,
      storePath: tmpDir,
      agentId: "chief",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const content = fs.readFileSync(result.transcriptPath, "utf-8").trim();
    const header = JSON.parse(content);
    expect(header.cwd).toBe(FAKE_WORKSPACE);
    expect(header.cwd).not.toBe(process.cwd());
    expect(header.type).toBe("session");
    expect(header.id).toBe(sessionId);
  });

  it("does not overwrite an existing transcript file", () => {
    const sessionId = "test-session-002";
    const first = ensureSessionTranscriptFile({
      cfg: {} as never,
      sessionId,
      storePath: tmpDir,
      agentId: "chief",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const originalContent = fs.readFileSync(first.transcriptPath, "utf-8");

    const second = ensureSessionTranscriptFile({
      cfg: {} as never,
      sessionId,
      storePath: tmpDir,
      agentId: "chief",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }

    expect(fs.readFileSync(second.transcriptPath, "utf-8")).toBe(originalContent);
  });
});
