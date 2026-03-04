import { describe, expect, it } from "vitest";
import {
  resolveCommandAuthorizedFromAuthorizers,
  resolveControlCommandGate,
} from "./command-gating.js";

describe("resolveCommandAuthorizedFromAuthorizers", () => {
  it("denies when useAccessGroups is enabled and no authorizer is configured", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: true,
        authorizers: [{ configured: false, allowed: true }],
      }),
    ).toBe(false);
  });

  it("allows when useAccessGroups is enabled and any configured authorizer allows", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: true,
        authorizers: [
          { configured: true, allowed: false },
          { configured: true, allowed: true },
        ],
      }),
    ).toBe(true);
  });

  it("allows when useAccessGroups is disabled (default)", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: false,
        authorizers: [{ configured: true, allowed: false }],
      }),
    ).toBe(true);
  });

  it("honors modeWhenAccessGroupsOff=deny", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: false,
        authorizers: [{ configured: false, allowed: true }],
        modeWhenAccessGroupsOff: "deny",
      }),
    ).toBe(false);
  });

  it("honors modeWhenAccessGroupsOff=configured (allow when none configured)", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: false,
        authorizers: [{ configured: false, allowed: false }],
        modeWhenAccessGroupsOff: "configured",
      }),
    ).toBe(true);
  });

  it("honors modeWhenAccessGroupsOff=configured (enforce when configured)", () => {
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: false,
        authorizers: [{ configured: true, allowed: false }],
        modeWhenAccessGroupsOff: "configured",
      }),
    ).toBe(false);
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: false,
        authorizers: [{ configured: true, allowed: true }],
        modeWhenAccessGroupsOff: "configured",
      }),
    ).toBe(true);
  });
});

describe("resolveCommandAuthorizedFromAuthorizers — open-access when nothing configured", () => {
  it("allows guild slash commands when useAccessGroups is enabled, modeWhenAccessGroupsOn is 'configured', and no authorizer is configured", () => {
    // Scenario: guild slash command, discordConfig.allowFrom is not set (ownerAllowList=null →
    // configured:false) and no dm.allowFrom leak, no channel/role restrictions.
    // With modeWhenAccessGroupsOn:"configured", open access should apply when nothing is configured.
    // Bug: without this parameter, the useAccessGroups=true path always uses some(configured&&allowed)
    // which returns false when no authorizer is configured, blocking guild users unexpectedly.
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: true,
        modeWhenAccessGroupsOn: "configured",
        authorizers: [
          { configured: false, allowed: false }, // ownerAllowList is null (no allowFrom set)
          { configured: false, allowed: true }, // no member/role restrictions (open)
        ],
        modeWhenAccessGroupsOff: "configured",
      }),
    ).toBe(true);
  });

  it("still denies when useAccessGroups is enabled without modeWhenAccessGroupsOn and no authorizer configured (fail-closed)", () => {
    // Default behavior (no modeWhenAccessGroupsOn) remains fail-closed for channels
    // like Slack where unknown-channel access should be denied.
    expect(
      resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: true,
        authorizers: [
          { configured: false, allowed: false },
          { configured: false, allowed: true },
        ],
        modeWhenAccessGroupsOff: "configured",
      }),
    ).toBe(false);
  });
});

describe("resolveControlCommandGate", () => {
  it("blocks control commands when unauthorized", () => {
    const result = resolveControlCommandGate({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: false }],
      allowTextCommands: true,
      hasControlCommand: true,
    });
    expect(result.commandAuthorized).toBe(false);
    expect(result.shouldBlock).toBe(true);
  });

  it("does not block when control commands are disabled", () => {
    const result = resolveControlCommandGate({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: false }],
      allowTextCommands: false,
      hasControlCommand: true,
    });
    expect(result.shouldBlock).toBe(false);
  });
});
