// Doctor config-flow include-warning tests cover config include warnings during repair.
import { describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { noteDoctorConfigPreflightIssues } from "./doctor-config-analysis.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

const noteSpy = vi.mocked(note);

describe("doctor include warning", () => {
  it("surfaces include confinement hint for escaped include paths", () => {
    noteDoctorConfigPreflightIssues(
      {
        path: "/tmp/openclaw-config/openclaw.json",
        exists: true,
        raw: '{"$include":"/etc/passwd"}',
        parsed: { $include: "/etc/passwd" },
        sourceConfig: {},
        resolved: {},
        runtimeConfig: {},
        config: {},
        valid: false,
        warnings: [],
        legacyIssues: [],
        issues: [
          {
            path: "$include",
            message: "Include path escapes config directory: /etc/passwd",
          },
        ],
      },
      { activeRepair: false },
    );

    expect(noteSpy).toHaveBeenCalledWith(
      [
        "- $include paths must stay under: /tmp/openclaw-config",
        '- Move shared include files under that directory and update to relative paths like "./shared/common.json".',
        "- Error: Include path escapes config directory: /etc/passwd",
      ].join("\n"),
      "Doctor warnings",
    );
  });
});
