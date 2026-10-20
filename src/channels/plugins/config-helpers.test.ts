import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearAccountEntryFields,
  clearAccountFieldsFromConfigSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "./config-helpers.js";

const selection = { sectionKey: "sample", accountId: "Work Phone" };
const policy = { canonicalAliasesRequireOwnField: "account" };

describe("public account config writers", () => {
  it.each([false, true])(
    "setAccountEnabledInConfigSection preserves rejected aliases when policy is %s",
    (declared) => {
      const alias = { allowFrom: ["bob"] };
      const cfg = {
        channels: { sample: { allowFrom: ["alice"], accounts: { "Work Phone": alias } } },
      };
      const result = setAccountEnabledInConfigSection({
        cfg,
        ...selection,
        accountKeyPolicy: declared ? policy : undefined,
        enabled: false,
      });
      expect(result.channels?.sample).toEqual({
        allowFrom: ["alice"],
        accounts: declared
          ? { "Work Phone": alias, "work-phone": { enabled: false } }
          : { "Work Phone": { ...alias, enabled: false } },
      });
    },
  );

  it.each(
    [false, true].flatMap((declared) =>
      ["delete", "clear"].map((operation) => ({ declared, operation })),
    ),
  )(
    "deleteAccountFromConfigSection / clearAccountEntryFields: $operation honors policy=$declared",
    ({ declared, operation }) => {
      const accounts = { "Work Phone": { secret: "authored", allowFrom: ["bob"] } };
      const cfg = { channels: { sample: { allowFrom: ["alice"], accounts } } };
      const accountKeyPolicy = declared ? policy : undefined;
      if (operation === "delete") {
        expect(
          deleteAccountFromConfigSection({
            cfg,
            ...selection,
            accountKeyPolicy,
          }).channels?.sample,
        ).toEqual({ allowFrom: ["alice"], accounts: declared ? accounts : undefined });
      } else {
        expect(
          clearAccountEntryFields({
            accounts,
            accountId: "Work Phone",
            accountKeyPolicy,
            fields: ["secret"],
          }),
        ).toEqual({
          nextAccounts: declared ? accounts : { "Work Phone": { allowFrom: ["bob"] } },
          changed: !declared,
          cleared: !declared,
        });
      }
    },
  );
});

describe("clearAccountFieldsFromConfigSection", () => {
  function clear(cfg: OpenClawConfig, accountId = "default", markClearedOnFieldPresence = false) {
    const original = structuredClone(cfg);
    const result = clearAccountFieldsFromConfigSection({
      cfg,
      sectionKey: "sample",
      accountId,
      fields: ["token", "secret"],
      markClearedOnFieldPresence,
    });
    expect(cfg).toEqual(original);
    return result;
  }

  function expectCleared(cfg: OpenClawConfig, nextConfig: OpenClawConfig, accountId = "default") {
    expect(clear(cfg, accountId)).toEqual({ nextConfig, changed: true, cleared: true });
  }

  it("clears the entire root field group for a truthy secret reference", () => {
    const token = { source: "env", provider: "default", id: "SAMPLE_TOKEN" };
    const cfg: OpenClawConfig = {
      channels: {
        sample: { token, secret: "", accounts: {}, name: "Keep" },
        other: { enabled: false },
      },
    };
    expectCleared(cfg, {
      channels: { sample: { accounts: {}, name: "Keep" }, other: { enabled: false } },
    });
  });

  it("preserves nested field-presence reporting", () => {
    const sibling = { token: "keep" };
    const cfg: OpenClawConfig = {
      channels: {
        sample: { accounts: { primary: { token: "   ", secret: "", name: "Keep" }, sibling } },
      },
    };
    expect(clear(cfg, "primary", true)).toEqual({
      nextConfig: { channels: { sample: { accounts: { primary: { name: "Keep" }, sibling } } } },
      changed: true,
      cleared: true,
    });
  });

  it("normalizes an empty nested account id without clearing root fields", () => {
    const cfg: OpenClawConfig = {
      channels: { sample: { token: "root", accounts: { default: { token: "nested" } } } },
    };
    expectCleared(cfg, { channels: { sample: { token: "root" } } }, "");
  });

  it("returns original config without pruning a no-op", () => {
    const cfg = { channels: {} };
    const result = clear(cfg);
    expect(result).toEqual({ nextConfig: cfg, changed: false, cleared: false });
    expect(result.nextConfig).toBe(cfg);
  });

  it("prunes changed empty account, channel, and channels objects", () => {
    expectCleared({ channels: { sample: { accounts: { default: { token: "remove" } } } } }, {});
  });
});
