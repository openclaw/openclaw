import { describe, expect, it } from "vitest";
import {
  buildOpenGroupPolicyConfigureRouteAllowlistWarning,
  buildOpenGroupPolicyNoRouteAllowlistWarning,
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
} from "./group-policy-warnings.js";

describe("group policy warning builders", () => {
  it("builds base open-policy warning", () => {
    expect(
      buildOpenGroupPolicyWarning({
        surface: "Example groups",
        openBehavior: "allows any member to trigger (mention-gated)",
        remediation: 'Set channels.example.groupPolicy="allowlist"',
      }),
    ).toBe(
      '- Example groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.example.groupPolicy="allowlist".',
    );
  });

  it("builds restrict-senders warning", () => {
    expect(
      buildOpenGroupPolicyRestrictSendersWarning({
        surface: "Example groups",
        openScope: "any member in allowed groups",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ).toBe(
      '- Example groups: groupPolicy="open" allows any member in allowed groups to trigger (mention-gated). Set channels.example.groupPolicy="allowlist" + channels.example.groupAllowFrom to restrict senders.',
    );
  });

  it("builds no-route-allowlist warning", () => {
    expect(
      buildOpenGroupPolicyNoRouteAllowlistWarning({
        surface: "Example groups",
        routeAllowlistPath: "channels.example.groups",
        routeScope: "group",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ).toBe(
      '- Example groups: groupPolicy="open" with no channels.example.groups allowlist; any group can add + ping (mention-gated). Set channels.example.groupPolicy="allowlist" + channels.example.groupAllowFrom or configure channels.example.groups.',
    );
  });

  it("builds configure-route-allowlist warning", () => {
    expect(
      buildOpenGroupPolicyConfigureRouteAllowlistWarning({
        surface: "Example channels",
        openScope: "any channel not explicitly denied",
        groupPolicyPath: "channels.example.groupPolicy",
        routeAllowlistPath: "channels.example.channels",
      }),
    ).toBe(
      '- Example channels: groupPolicy="open" allows any channel not explicitly denied to trigger (mention-gated). Set channels.example.groupPolicy="allowlist" and configure channels.example.channels.',
    );
  });
});
