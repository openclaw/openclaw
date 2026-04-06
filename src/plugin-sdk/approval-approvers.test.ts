import { describe, expect, it } from "vitest";
import {
  resolveApprovalApproverResolution,
  resolveApprovalApprovers,
} from "./approval-approvers.js";

function normalizeApprover(value: string | number): string | undefined {
  const normalized = String(value).trim().toLowerCase();
  return normalized || undefined;
}

describe("resolveApprovalApproverResolution", () => {
  it("preserves explicit and inferred approver sets while preferring explicit approvers", () => {
    expect(
      resolveApprovalApproverResolution({
        explicit: [" Owner ", "OWNER", 42],
        allowFrom: ["fallback-1", "owner"],
        extraAllowFrom: ["fallback-2", "FALLBACK-2"],
        defaultTo: "fallback-3",
        normalizeApprover,
      }),
    ).toEqual({
      explicit: ["owner", "42"],
      inferred: ["fallback-1", "owner", "fallback-2", "fallback-3"],
      effective: ["owner", "42"],
      source: "explicit",
    });
  });

  it("falls back to inferred approvers when explicit approvers normalize away", () => {
    expect(
      resolveApprovalApproverResolution({
        explicit: [" ", ""],
        allowFrom: ["fallback-1", "FALLBACK-1"],
        extraAllowFrom: ["fallback-2"],
        defaultTo: "fallback-3",
        normalizeApprover,
      }),
    ).toEqual({
      explicit: [],
      inferred: ["fallback-1", "fallback-2", "fallback-3"],
      effective: ["fallback-1", "fallback-2", "fallback-3"],
      source: "inferred",
    });
  });

  it("supports dedicated default target normalization", () => {
    expect(
      resolveApprovalApproverResolution({
        allowFrom: ["123"],
        defaultTo: " user:456 ",
        normalizeApprover,
        normalizeDefaultTo: (value) => value.trim().replace(/^user:/i, "") || undefined,
      }),
    ).toEqual({
      explicit: [],
      inferred: ["123", "456"],
      effective: ["123", "456"],
      source: "inferred",
    });
  });

  it("reports none when neither explicit nor inferred approvers resolve", () => {
    expect(
      resolveApprovalApproverResolution({
        explicit: [" "],
        allowFrom: [],
        extraAllowFrom: undefined,
        defaultTo: " ",
        normalizeApprover,
      }),
    ).toEqual({
      explicit: [],
      inferred: [],
      effective: [],
      source: "none",
    });
  });
});

describe("resolveApprovalApprovers", () => {
  it("keeps the legacy effective approver list behavior", () => {
    const params = {
      explicit: ["owner"],
      allowFrom: ["fallback"],
      defaultTo: "fallback-2",
      normalizeApprover,
    } as const;

    expect(resolveApprovalApprovers(params)).toEqual(
      resolveApprovalApproverResolution(params).effective,
    );
  });
});
