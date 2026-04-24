import { describe, expect, it } from "vitest";
import { describePluginInstallSource } from "./install-source-info.js";

describe("describePluginInstallSource", () => {
  it("marks exact npm specs with integrity as fully pinned", () => {
    expect(
      describePluginInstallSource({
        npmSpec: "@vendor/demo@1.2.3",
        expectedIntegrity: "sha512-demo",
        defaultChoice: "npm",
      }),
    ).toEqual({
      defaultChoice: "npm",
      npm: {
        spec: "@vendor/demo@1.2.3",
        packageName: "@vendor/demo",
        selector: "1.2.3",
        selectorKind: "exact-version",
        exactVersion: true,
        expectedIntegrity: "sha512-demo",
        pinState: "exact-with-integrity",
      },
      warnings: [],
    });
  });

  it("surfaces floating or missing-integrity npm metadata without rejecting it", () => {
    expect(
      describePluginInstallSource({
        npmSpec: "@vendor/demo@beta",
      }),
    ).toEqual({
      npm: {
        spec: "@vendor/demo@beta",
        packageName: "@vendor/demo",
        selector: "beta",
        selectorKind: "tag",
        exactVersion: false,
        pinState: "floating-without-integrity",
      },
      warnings: ["npm-spec-floating", "npm-spec-missing-integrity"],
    });
  });

  it("reports invalid npm specs while preserving local source metadata", () => {
    expect(
      describePluginInstallSource({
        npmSpec: "github:vendor/demo",
        localPath: "extensions/demo",
      }),
    ).toEqual({
      local: {
        path: "extensions/demo",
      },
      warnings: ["invalid-npm-spec"],
    });
  });
});
