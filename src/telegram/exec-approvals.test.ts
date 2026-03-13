import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalClientEnabled,
  resolveTelegramExecApprovalTarget,
  shouldEnableTelegramExecApprovalButtons,
  shouldInjectTelegramExecApprovalButtons,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>["execApprovals"],
): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "tok",
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

describe("telegram exec approvals", () => {
  it("requires enablement and at least one approver", () => {
    expect(isTelegramExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
    expect(
      isTelegramExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true }),
      }),
    ).toBe(false);
    expect(
      isTelegramExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true, approvers: ["123"] }),
      }),
    ).toBe(true);
  });

  it("matches approvers by normalized sender id", () => {
    const cfg = buildConfig({ enabled: true, approvers: [123, "456"] });
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "123" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "456" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "789" })).toBe(false);
  });

  it("defaults target to dm", () => {
    expect(
      resolveTelegramExecApprovalTarget({ cfg: buildConfig({ enabled: true, approvers: ["1"] }) }),
    ).toBe("dm");
  });

  it("only injects approval buttons on eligible telegram targets", () => {
    const dmCfg = buildConfig({ enabled: true, approvers: ["123"], target: "dm" });
    const channelCfg = buildConfig({ enabled: true, approvers: ["123"], target: "channel" });
    const bothCfg = buildConfig({ enabled: true, approvers: ["123"], target: "both" });

    expect(shouldInjectTelegramExecApprovalButtons({ cfg: dmCfg, to: "123" })).toBe(true);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: dmCfg, to: "-100123" })).toBe(false);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: channelCfg, to: "-100123" })).toBe(true);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: channelCfg, to: "123" })).toBe(false);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: bothCfg, to: "123" })).toBe(true);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: bothCfg, to: "-100123" })).toBe(true);
  });

  it("does not require generic inlineButtons capability to enable exec approval buttons", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          capabilities: ["vision"],
          execApprovals: { enabled: true, approvers: ["123"], target: "dm" },
        },
      },
    } as OpenClawConfig;

    expect(shouldEnableTelegramExecApprovalButtons({ cfg, to: "123" })).toBe(true);
  });

  it("still respects explicit inlineButtons off for exec approval buttons", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          capabilities: { inlineButtons: "off" },
          execApprovals: { enabled: true, approvers: ["123"], target: "dm" },
        },
      },
    } as OpenClawConfig;

    expect(shouldEnableTelegramExecApprovalButtons({ cfg, to: "123" })).toBe(false);
  });
});
