import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearAccountEntryFields,
  clearAccountFieldsFromConfigSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "./config-helpers.js";

const policy = { canonicalAliasesRequireOwnField: "account" };
function writerFixture(declared: boolean) {
  const accounts = { "Work Phone": { secret: "authored", allowFrom: ["bob"] } };
  const cfg = { channels: { sample: { allowFrom: ["alice"], accounts } } };
  const params = {
    cfg,
    sectionKey: "sample",
    accountId: "Work Phone",
    accountKeyPolicy: declared ? policy : undefined,
  };
  return { accounts, params };
}

describe("public account config writers", () => {
  it.each([false, true])("enable honors account policy=%s", (declared) => {
    const { accounts, params } = writerFixture(declared);
    expect(
      setAccountEnabledInConfigSection({ ...params, enabled: false }).channels?.sample,
    ).toEqual({
      allowFrom: ["alice"],
      accounts: declared
        ? { ...accounts, "work-phone": { enabled: false } }
        : { "Work Phone": { secret: "authored", allowFrom: ["bob"], enabled: false } },
    });
  });

  it.each([false, true])("delete honors account policy=%s", (declared) => {
    const { accounts, params } = writerFixture(declared);
    expect(deleteAccountFromConfigSection(params).channels?.sample).toEqual({
      allowFrom: ["alice"],
      accounts: declared ? accounts : undefined,
    });
  });

  it.each([false, true])("clear honors account policy=%s", (declared) => {
    const { accounts, params } = writerFixture(declared);
    expect(clearAccountEntryFields({ ...params, accounts, fields: ["secret"] })).toEqual({
      nextAccounts: declared ? accounts : { "Work Phone": { allowFrom: ["bob"] } },
      changed: !declared,
      cleared: !declared,
    });
  });
});

const sibling = { token: "keep" };
const token = { source: "env", provider: "default", id: "SAMPLE_TOKEN" };
const otherChannel = { enabled: false };
const clearArgs = { sectionKey: "sample", accountId: "default", fields: ["token", "secret"] };
function config(sample?: object, other?: object): OpenClawConfig {
  return sample || other
    ? { channels: { ...(sample ? { sample } : {}), ...(other ? { other } : {}) } }
    : {};
}

it.each([
  [
    "root field group",
    config({ token, secret: "", accounts: {}, name: "Keep" }, otherChannel),
    config({ accounts: {}, name: "Keep" }, otherChannel),
    {},
  ],
  [
    "nested field presence",
    config({ accounts: { primary: { token: "   ", secret: "", name: "Keep" }, sibling } }),
    config({ accounts: { primary: { name: "Keep" }, sibling } }),
    { accountId: "primary", markClearedOnFieldPresence: true },
  ],
  [
    "empty id preserves root",
    config({ token: "root", accounts: { default: { token: "nested" } } }),
    config({ token: "root" }),
    { accountId: "" },
  ],
  ["prunes empty config", config({ accounts: { default: { token: "remove" } } }), {}, {}],
] as const)("clear config: %s", (_name, cfg, nextConfig, options) => {
  const original = structuredClone(cfg);
  expect(
    clearAccountFieldsFromConfigSection({
      ...clearArgs,
      cfg,
      ...options,
    }),
  ).toEqual({ nextConfig, changed: true, cleared: true });
  expect(cfg).toEqual(original);
});

it("preserves config identity and empty channels on a no-op", () => {
  const cfg = { channels: {} };
  const result = clearAccountFieldsFromConfigSection({ ...clearArgs, cfg });
  expect(result).toEqual({ nextConfig: cfg, changed: false, cleared: false });
  expect(result.nextConfig).toBe(cfg);
});
