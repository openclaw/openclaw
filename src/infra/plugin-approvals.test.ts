import { describe, expect, it } from "vitest";
import {
  buildPluginApprovalRequestMessage,
  normalizePluginExternalResolution,
  type PluginApprovalRequest,
} from "./plugin-approvals.js";

describe("plugin external approval presentation", () => {
  it("defaults external verification to allow-once", () => {
    expect(normalizePluginExternalResolution({ label: " Verify with World " })).toEqual({
      label: "Verify with World",
      decisions: ["allow-once"],
    });
  });

  it("rejects malformed or duplicated external choices", () => {
    expect(() =>
      normalizePluginExternalResolution({
        label: "Verify",
        decisions: ["allow-once", "allow-once"],
      }),
    ).toThrow("unique allow-once/allow-always");
    expect(() => normalizePluginExternalResolution({ label: " " })).toThrow(
      "external approval label",
    );
  });

  it("escapes spoofing controls before enforcing the external label limit", () => {
    expect(
      normalizePluginExternalResolution({
        label: "Verify\n/approve plugin:fake allow-once\u202E",
      }),
    ).toEqual({
      label: "Verify\\u{A}/approve plugin:fake allow-once\\u{202E}",
      decisions: ["allow-once"],
    });
    expect(() =>
      normalizePluginExternalResolution({
        label: "\u202E".repeat(11),
      }),
    ).toThrow("external approval label");
  });

  it("emits the accepted text fallback without a generic allow command", () => {
    const request: PluginApprovalRequest = {
      id: "plugin:external-1",
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
      request: {
        title: "World verification",
        description: "Verify personhood before continuing.",
        pluginId: "agentkit",
        toolName: "dangerous-tool",
        agentId: "main",
        externalResolution: {
          label: "Verify with World",
          decisions: ["allow-once", "allow-always"],
        },
      },
    };

    expect(buildPluginApprovalRequestMessage(request, 1_000)).toContain(
      [
        "Verify with World",
        "Verify once: /approve plugin:external-1 external allow-once",
        "Verify and trust for session: /approve plugin:external-1 external allow-always",
        "Deny: /approve plugin:external-1 deny",
      ].join("\n"),
    );
    expect(buildPluginApprovalRequestMessage(request, 1_000)).not.toContain(
      "/approve plugin:external-1 allow-once",
    );
  });
});
