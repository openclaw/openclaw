import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";

// Mock the dependencies
vi.mock("../infra/exec-approvals.js", () => ({
  loadExecApprovals: vi.fn(),
}));

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

import { loadExecApprovals } from "../infra/exec-approvals.js";
import { note } from "../terminal/note.js";
import { noteExecApprovalsWarnings } from "./doctor-exec-approvals.js";

const mockLoadExecApprovals = vi.mocked(loadExecApprovals);
const mockNote = vi.mocked(note);

describe("noteExecApprovalsWarnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("warns when approvals.exec.enabled=false but gating is active", () => {
    const cfg: OpenClawConfig = {
      approvals: {
        exec: {
          enabled: false,
        },
      },
    };

    const execApprovals: ExecApprovalsFile = {
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "on-miss",
      },
    };
    mockLoadExecApprovals.mockReturnValue(execApprovals);

    noteExecApprovalsWarnings(cfg);

    expect(mockNote).toHaveBeenCalledTimes(1);
    const [message, title] = mockNote.mock.calls[0];
    expect(title).toBe("Exec Approvals");
    expect(message).toContain("approvals.exec.enabled=false");
    expect(message).toContain("exec-approvals.json has active gating");
    expect(message).toContain('security="allowlist"');
    expect(message).toContain('ask="on-miss"');
  });

  it("no warning when approvals.exec.enabled=false and gating is disabled", () => {
    const cfg: OpenClawConfig = {
      approvals: {
        exec: {
          enabled: false,
        },
      },
    };

    const execApprovals: ExecApprovalsFile = {
      version: 1,
      defaults: {
        security: "full",
        ask: "off",
      },
    };
    mockLoadExecApprovals.mockReturnValue(execApprovals);

    noteExecApprovalsWarnings(cfg);

    expect(mockNote).not.toHaveBeenCalled();
  });

  it("warns when tools.exec.security differs from exec-approvals.json", () => {
    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          security: "full",
        },
      },
    };

    const execApprovals: ExecApprovalsFile = {
      version: 1,
      defaults: {
        security: "allowlist",
      },
    };
    mockLoadExecApprovals.mockReturnValue(execApprovals);

    noteExecApprovalsWarnings(cfg);

    expect(mockNote).toHaveBeenCalledTimes(1);
    const [message] = mockNote.mock.calls[0];
    expect(message).toContain('tools.exec.security="full"');
    expect(message).toContain('exec-approvals.json security="allowlist"');
    expect(message).toContain("takes precedence");
  });

  it("warns when tools.exec.ask differs from exec-approvals.json", () => {
    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          ask: "always",
        },
      },
    };

    const execApprovals: ExecApprovalsFile = {
      version: 1,
      defaults: {
        ask: "off",
      },
    };
    mockLoadExecApprovals.mockReturnValue(execApprovals);

    noteExecApprovalsWarnings(cfg);

    expect(mockNote).toHaveBeenCalledTimes(1);
    const [message] = mockNote.mock.calls[0];
    expect(message).toContain('tools.exec.ask="always"');
    expect(message).toContain('exec-approvals.json ask="off"');
  });

  it("no warning when all configs are aligned", () => {
    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          security: "allowlist",
          ask: "on-miss",
        },
      },
    };

    const execApprovals: ExecApprovalsFile = {
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "on-miss",
      },
    };
    mockLoadExecApprovals.mockReturnValue(execApprovals);

    noteExecApprovalsWarnings(cfg);

    expect(mockNote).not.toHaveBeenCalled();
  });

  it("no warning when no exec config is set", () => {
    const cfg: OpenClawConfig = {};

    const execApprovals: ExecApprovalsFile = {
      version: 1,
    };
    mockLoadExecApprovals.mockReturnValue(execApprovals);

    noteExecApprovalsWarnings(cfg);

    expect(mockNote).not.toHaveBeenCalled();
  });

  it("handles missing defaults in exec-approvals.json gracefully", () => {
    const cfg: OpenClawConfig = {
      approvals: {
        exec: {
          enabled: false,
        },
      },
    };

    const execApprovals: ExecApprovalsFile = {
      version: 1,
      // no defaults set - should use fallback values
    };
    mockLoadExecApprovals.mockReturnValue(execApprovals);

    noteExecApprovalsWarnings(cfg);

    // Should warn because default security is "deny" and ask is "on-miss"
    expect(mockNote).toHaveBeenCalledTimes(1);
    const [message] = mockNote.mock.calls[0];
    expect(message).toContain('security="deny"');
    expect(message).toContain('ask="on-miss"');
  });
});
