import { describe, expect, it } from "vitest";
import {
  resolveExecApprovalCommandDisplay,
  sanitizeExecApprovalDisplayText,
} from "./exec-approval-command-display.js";

describe("sanitizeExecApprovalDisplayText", () => {
  it("escapes unicode format characters but leaves other text intact", () => {
    expect(sanitizeExecApprovalDisplayText("echo hi\u200Bthere")).toBe("echo hi\\u{200B}there");
  });

  it("escapes visually blank hangul filler characters used for spoofing", () => {
    expect(sanitizeExecApprovalDisplayText("date\u3164\uFFA0\u115F\u1160가")).toBe(
      "date\\u{3164}\\u{FFA0}\\u{115F}\\u{1160}가",
    );
  });
});

describe("resolveExecApprovalCommandDisplay", () => {
  it("prefers explicit command fields and drops identical previews after trimming", () => {
    expect(
      resolveExecApprovalCommandDisplay({
        command: "echo hi",
        commandPreview: "  echo hi  ",
        host: "gateway",
      }),
    ).toEqual({
      commandText: "echo hi",
      commandPreview: null,
    });
  });

  it("falls back to node systemRunPlan values and sanitizes preview text", () => {
    expect(
      resolveExecApprovalCommandDisplay({
        command: "",
        host: "node",
        systemRunPlan: {
          argv: ["python3", "-c", "print(1)"],
          cwd: null,
          commandText: 'python3 -c "print(1)"',
          commandPreview: "print\u200B(1)",
          agentId: null,
          sessionKey: null,
        },
      }),
    ).toEqual({
      commandText: 'python3 -c "print(1)"',
      commandPreview: "print\\u{200B}(1)",
    });
  });

  it("ignores systemRunPlan fallback for non-node hosts", () => {
    expect(
      resolveExecApprovalCommandDisplay({
        command: "",
        host: "sandbox",
        systemRunPlan: {
          argv: ["echo", "hi"],
          cwd: null,
          commandText: "echo hi",
          commandPreview: "echo hi",
          agentId: null,
          sessionKey: null,
        },
      }),
    ).toEqual({
      commandText: "",
      commandPreview: null,
    });
  });
});
