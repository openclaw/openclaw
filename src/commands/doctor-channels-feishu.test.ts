import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { diagnoseFeishuChannel } from "./doctor-channels-feishu.js";

describe("diagnoseFeishuChannel", () => {
  it("should report Feishu not configured", async () => {
    const cfg: OpenClawConfig = {};
    const result = await diagnoseFeishuChannel(cfg);

    expect(result.enabled).toBe(false);
    expect(result.issues).toContainEqual(expect.stringContaining("Feishu channel not configured"));
  });

  it("should report Feishu disabled", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          enabled: false,
        },
      },
    };
    const result = await diagnoseFeishuChannel(cfg);

    expect(result.enabled).toBe(false);
    expect(result.issues).toContainEqual(expect.stringContaining("Feishu channel is disabled"));
  });

  it("should report missing accounts", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {},
        },
      },
    };
    const result = await diagnoseFeishuChannel(cfg);

    expect(result.enabled).toBe(true);
    expect(result.issues).toContainEqual(expect.stringContaining("No Feishu accounts configured"));
  });

  it("should report missing AppID/AppSecret", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            admin: {
              appId: "",
              appSecret: "",
            },
          },
        },
      },
    };
    const result = await diagnoseFeishuChannel(cfg);

    expect(result.issues).toContainEqual(expect.stringContaining("Missing AppID or AppSecret"));
  });

  it("should detect allowlist mode without groupAllowFrom", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            admin: {
              appId: "test_app_id",
              appSecret: "TEST_SECRET_PLACEHOLDER", // pragma: allowlist secret
            },
            default: {
              groupPolicy: "allowlist",
            },
          },
        },
      },
    };
    const result = await diagnoseFeishuChannel(cfg);

    expect(result.issues).toContainEqual(
      expect.stringContaining("groupAllowFrom is not configured"),
    );
    expect(result.issues).toContainEqual(expect.stringContaining("block ALL group messages"));
  });

  it("should warn about open group policy", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            admin: {
              appId: "test_app_id",
              appSecret: "TEST_SECRET_PLACEHOLDER", // pragma: allowlist secret
            },
            default: {
              groupPolicy: "open",
            },
          },
        },
      },
    };
    const result = await diagnoseFeishuChannel(cfg);

    expect(result.warnings).toContainEqual(expect.stringContaining('Group policy is "open"'));
  });

  it("should detect groups not in groupAllowFrom", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            admin: {
              appId: "test_app_id",
              appSecret: "TEST_SECRET_PLACEHOLDER", // pragma: allowlist secret
            },
            default: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["oc_allowed_group"],
            },
          },
          groups: {
            oc_allowed_group: {
              allow: ["user1"],
            },
            oc_missing_group: {
              allow: ["user2"],
            },
          },
        },
      },
    };
    const result = await diagnoseFeishuChannel(cfg);

    expect(result.warnings).toContainEqual(expect.stringContaining("not in groupAllowFrom"));
    expect(result.warnings).toContainEqual(expect.stringContaining("oc_missing_group"));
  });

  it("should validate complete configuration", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            admin: {
              appId: "test_app_id",
              appSecret: "TEST_SECRET_PLACEHOLDER", // pragma: allowlist secret
            },
            default: {
              appId: "test_app_id_default",
              appSecret: "TEST_SECRET_DEFAULT_PLACEHOLDER", // pragma: allowlist secret
              groupPolicy: "allowlist",
              groupAllowFrom: ["oc_group1", "oc_group2"],
            },
          },
          groups: {
            oc_group1: {
              allowFrom: ["user1"],
              requireMention: true,
            },
            oc_group2: {
              allowFrom: ["user2"],
            },
          },
        },
      },
    };
    const result = await diagnoseFeishuChannel(cfg);

    expect(result.issues).toHaveLength(0);
    expect(result.accountsConfigured).toBe(2); // admin + default
    expect(result.groupsConfigured).toBe(2);
    expect(result.tips).toContainEqual(expect.stringContaining("Mention required"));
  });

  it("should detect webhook mode", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            admin: {
              appId: "test_app_id",
              appSecret: "TEST_SECRET_PLACEHOLDER", // pragma: allowlist secret
            },
          },
          connectionMode: "webhook",
        },
      },
    };
    const result = await diagnoseFeishuChannel(cfg);

    expect(result.tips).toContainEqual(expect.stringContaining("webhook mode"));
    expect(result.warnings).toContainEqual(expect.stringContaining("webhook URL configuration"));
  });
});
