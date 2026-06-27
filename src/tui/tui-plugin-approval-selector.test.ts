// Covers TUI-local plugin approval selector rows.
import { describe, expect, it } from "vitest";
import { buildPluginApprovalSelectorItems } from "./tui-plugin-approval-selector.js";

describe("buildPluginApprovalSelectorItems", () => {
  it("uses external verification commands and keeps deny as a local approval command", () => {
    const items = buildPluginApprovalSelectorItems({
      id: "plugin:approval-1",
      request: {
        title: "World proof required",
        description: "Verify before exec",
        allowedDecisions: ["deny"],
        externalResolution: {
          label: "Verify with World",
          commands: [
            {
              decision: "allow-once",
              label: "Verify once",
              description: "Approve this blocked action only",
              command: "/agentkit approve plugin:approval-1 allow-once",
            },
            {
              decision: "allow-always",
              label: "Verify and trust for session",
              description: "Trust approvals for this session",
              command: "/agentkit approve plugin:approval-1 allow-always",
            },
          ],
        },
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(items).toEqual([
      {
        value: "/agentkit approve plugin:approval-1 allow-once",
        label: "Verify once",
        description: "Approve this blocked action only",
      },
      {
        value: "/agentkit approve plugin:approval-1 allow-always",
        label: "Verify and trust for session",
        description: "Trust approvals for this session",
      },
      {
        value: "/approve plugin:approval-1 deny",
        label: "Deny",
        description: "Reject this blocked action",
      },
    ]);
  });

  it("falls back to direct approval decisions when no external verification exists", () => {
    const items = buildPluginApprovalSelectorItems({
      id: "plugin:approval-2",
      request: {
        title: "Approval required",
        description: "Choose a decision",
        allowedDecisions: ["allow-once", "deny"],
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(items).toEqual([
      {
        value: "/approve plugin:approval-2 allow-once",
        label: "Allow once",
        description: "Approve this blocked action only",
      },
      {
        value: "/approve plugin:approval-2 deny",
        label: "Deny",
        description: "Reject this blocked action",
      },
    ]);
  });
});
