import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("channels.msteams", () => {
  it("accepts named account display names", () => {
    const result = OpenClawSchema.safeParse({
      channels: {
        msteams: {
          tenantId: "tenant-id",
          accounts: {
            support: {
              name: "Support Teams bot",
              appId: "app-id",
              appPassword: "app-password",
              webhook: { path: "/api/messages/support" },
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("preserves omitted named-account policies so they inherit from the channel root", () => {
    const result = OpenClawSchema.safeParse({
      channels: {
        msteams: {
          tenantId: "tenant-id",
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
          groupAllowFrom: ["*"],
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-password",
              webhook: { path: "/api/messages/support" },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const account = result.data.channels?.msteams?.accounts?.support;
      expect(account?.dmPolicy).toBeUndefined();
      expect(account?.groupPolicy).toBeUndefined();
    }
  });

  it("allows draft named accounts when the channel is globally disabled", () => {
    const result = OpenClawSchema.safeParse({
      channels: {
        msteams: {
          enabled: false,
          accounts: {
            support: {},
            legal: { webhook: { path: "/api/messages/support" } },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
