import { describe, expect, it } from "vitest";
import {
  createScopedAccountConfigAccessors,
  mapAllowFromEntries,
  resolveOptionalConfigString,
} from "./channel-config-helpers.js";

describe("mapAllowFromEntries", () => {
  it("coerces allowFrom entries to strings", () => {
    expect(mapAllowFromEntries(["user", 42, null])).toEqual(["user", "42", "null"]);
  });

  it("returns empty list for missing input", () => {
    expect(mapAllowFromEntries(undefined)).toEqual([]);
  });
});

describe("resolveOptionalConfigString", () => {
  it("trims and returns string values", () => {
    expect(resolveOptionalConfigString("  room:123  ")).toBe("room:123");
  });

  it("coerces numeric values", () => {
    expect(resolveOptionalConfigString(123)).toBe("123");
  });

  it("returns undefined for empty values", () => {
    expect(resolveOptionalConfigString("   ")).toBeUndefined();
    expect(resolveOptionalConfigString(undefined)).toBeUndefined();
  });
});

describe("createScopedAccountConfigAccessors", () => {
  it("maps allowFrom and defaultTo from the resolved account", () => {
    const accessors = createScopedAccountConfigAccessors({
      resolveAccount: ({ accountId }) => ({
        allowFrom: accountId ? [accountId, 42] : ["fallback"],
        defaultTo: " room:123 ",
      }),
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).toUpperCase()),
      resolveDefaultTo: (account) => account.defaultTo,
    });

    expect(
      accessors.resolveAllowFrom?.({
        cfg: {},
        accountId: "owner",
      }),
    ).toEqual(["owner", "42"]);
    expect(
      accessors.formatAllowFrom?.({
        cfg: {},
        allowFrom: ["owner"],
      }),
    ).toEqual(["OWNER"]);
    expect(
      accessors.resolveDefaultTo?.({
        cfg: {},
        accountId: "owner",
      }),
    ).toBe("room:123");
  });

  it("omits resolveDefaultTo when no selector is provided", () => {
    const accessors = createScopedAccountConfigAccessors({
      resolveAccount: () => ({ allowFrom: ["owner"] }),
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
    });

    expect(accessors.resolveDefaultTo).toBeUndefined();
  });
});
