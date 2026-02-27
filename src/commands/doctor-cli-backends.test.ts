import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBackendAvailability } from "../agents/cli-backend-availability.js";
import { noteCliBackendHealth } from "./doctor-cli-backends.js";

vi.mock("../agents/cli-backend-availability.js", () => ({
  checkCliBackendAvailability: vi.fn(),
}));

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

const { checkCliBackendAvailability } = await import("../agents/cli-backend-availability.js");
const { note } = await import("../terminal/note.js");

const mockCheck = vi.mocked(checkCliBackendAvailability);
const mockNote = vi.mocked(note);

function mockAvailability(overrides: Partial<CliBackendAvailability>): CliBackendAvailability {
  return {
    id: "claude-cli",
    binaryName: "claude",
    binaryFound: true,
    binaryPath: "/usr/local/bin/claude",
    credentialsFound: true,
    credentialsPath: "/home/user/.claude/.credentials.json",
    configDirExists: true,
    configDirPath: "/home/user/.claude",
    ...overrides,
  };
}

describe("noteCliBackendHealth", () => {
  beforeEach(() => {
    mockCheck.mockReset();
    mockNote.mockReset();
  });

  it("skips when model is not a CLI provider", async () => {
    await noteCliBackendHealth({
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    });
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockNote).not.toHaveBeenCalled();
  });

  it("skips when no model configured", async () => {
    await noteCliBackendHealth({});
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("checks claude-cli and reports warnings", async () => {
    mockCheck.mockResolvedValue(
      mockAvailability({ binaryFound: false, binaryPath: undefined, credentialsFound: false }),
    );

    await noteCliBackendHealth({
      agents: { defaults: { model: { primary: "claude-cli/sonnet" } } },
    });

    expect(mockCheck).toHaveBeenCalledWith("claude-cli");
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("claude binary not found"),
      "CLI backend",
    );
  });

  it("does not warn when everything is healthy", async () => {
    mockCheck.mockResolvedValue(mockAvailability({ binaryFound: true, credentialsFound: true }));

    await noteCliBackendHealth({
      agents: { defaults: { model: { primary: "claude-cli/sonnet" } } },
    });

    expect(mockCheck).toHaveBeenCalled();
    expect(mockNote).not.toHaveBeenCalled();
  });

  it("checks codex-cli provider", async () => {
    mockCheck.mockResolvedValue(
      mockAvailability({
        id: "codex-cli",
        binaryName: "codex",
        binaryFound: true,
        credentialsFound: false,
      }),
    );

    await noteCliBackendHealth({
      agents: { defaults: { model: { primary: "codex-cli/codex" } } },
    });

    expect(mockCheck).toHaveBeenCalledWith("codex-cli");
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("Credentials not found"),
      "CLI backend",
    );
  });
});
