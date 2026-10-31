// Open policy allow-from tests cover doctor handling of open allowlist policy.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { GoogleChatConfigSchema } from "../../../config/zod-schema.providers-googlechat.js";
import {
  collectOpenPolicyAllowFromWarnings,
  maybeRepairOpenPolicyAllowFrom,
} from "./open-policy-allowfrom.js";

describe("doctor open-policy allowFrom repair", () => {
  it("repairs top-level googlechat allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        googlechat: {
          dmPolicy: "open",
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.googlechat.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.googlechat?.allowFrom).toEqual(["*"]);
    expect(GoogleChatConfigSchema.safeParse(result.config.channels?.googlechat).success).toBe(true);
  });

  it("repairs per-account open dmPolicy without allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        discord: {
          accounts: {
            work: {
              dmPolicy: "open",
            },
          },
        },
      },
    });

    expect(result.config.channels?.discord?.accounts?.work?.allowFrom).toEqual(["*"]);
  });

  it("does not widen QQBot chat access while allowFrom protects native approvals", () => {
    const config = {
      channels: {
        qqbot: {
          dmPolicy: "open",
          allowFrom: ["openclaw:approval-disabled"],
          accounts: {
            work: {
              dmPolicy: "open",
              allowFrom: ["OPERATOR"],
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const first = maybeRepairOpenPolicyAllowFrom(config);
    const second = maybeRepairOpenPolicyAllowFrom(first.config);

    expect(first).toEqual({ config, changes: [] });
    expect(second).toEqual({ config, changes: [] });
  });

  it("formats open-policy wildcard warnings", () => {
    const warnings = collectOpenPolicyAllowFromWarnings({
      changes: ['- channels.signal.allowFrom: set to ["*"] (required by dmPolicy="open")'],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      '- channels.signal.allowFrom: set to ["*"] (required by dmPolicy="open")',
      '- Run "openclaw doctor --fix" to add missing allowFrom wildcards.',
    ]);
  });
});
