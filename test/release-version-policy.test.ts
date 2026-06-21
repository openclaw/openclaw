import { describe, expect, it } from "vitest";
import { validateStrictPublishPolicy } from "../scripts/lib/release-version-policy.mjs";

describe("validateStrictPublishPolicy", () => {
  it.each([
    ["2026.7.1-alpha.1", "alpha", "alpha"],
    ["2026.7.1-beta.1", "beta", "beta"],
    ["2026.7.1", "daily", "daily"],
    ["2026.7.32", "daily", "daily"],
    ["2026.7.33", "stable", "stable-base"],
    ["2026.7.34", "stable", "stable-patch"],
    ["2026.7.9007199254740991", "stable", "stable-patch"],
  ] as const)("accepts %s with selector %s as %s", (version, releaseSelector, releaseClass) => {
    expect(validateStrictPublishPolicy({ version, releaseSelector })).toMatchObject({
      parsedVersion: { version, releaseClass },
      releaseClass,
    });
  });

  it.each([
    ["2026.7.32", "stable"],
    ["2026.7.33", "daily"],
    ["2026.7.34", "daily"],
    ["2026.7.1-alpha.1", "daily"],
    ["2026.7.1-beta.1", "stable"],
  ] as const)("rejects version %s with mismatched selector %s", (version, releaseSelector) => {
    expect(() => validateStrictPublishPolicy({ version, releaseSelector })).toThrow(
      /does not match release class/u,
    );
  });

  it.each(["2026.7.1-1", "2026.7.33-1", "2026.7.34-2"])(
    "rejects historical numeric correction %s",
    (version) => {
      expect(() => validateStrictPublishPolicy({ version, releaseSelector: "stable" })).toThrow(
        /numeric correction/u,
      );
    },
  );

  it.each([
    undefined,
    null,
    [],
    {},
    { version: "2026.7.1" },
    { releaseSelector: "daily" },
    { version: "2026.7.1", releaseSelector: "daily", unexpected: true },
    { version: "2026.7.1", releaseSelector: "latest" },
    { version: null, releaseSelector: "daily" },
  ])("rejects non-closed input %#", (input) => {
    expect(() =>
      validateStrictPublishPolicy(
        input as { version: string; releaseSelector: "alpha" | "beta" | "daily" | "stable" },
      ),
    ).toThrow();
  });

  it.each([
    "",
    "0000.7.1",
    "2026.0.1",
    "2026.13.1",
    "2026.7.0",
    "2026.7.9007199254740992",
    "2026.7.1-alpha.0",
    "2026.7.1-beta.9007199254740992",
  ])("rejects unsupported version %j", (version) => {
    expect(() => validateStrictPublishPolicy({ version, releaseSelector: "daily" })).toThrow(
      /Unsupported release version/u,
    );
  });
});
