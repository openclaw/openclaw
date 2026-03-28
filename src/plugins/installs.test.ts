import { describe, expect, it } from "vitest";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "./installs.js";

function expectRecordedInstall(pluginId: string, next: ReturnType<typeof recordPluginInstall>) {
  expect(next.plugins?.installs?.[pluginId]).toMatchObject({
    source: "npm",
    spec: `${pluginId}@latest`,
  });
  expect(typeof next.plugins?.installs?.[pluginId]?.installedAt).toBe("string");
}

describe("buildNpmResolutionInstallFields", () => {
  it.each([
    {
      name: "maps npm resolution metadata into install record fields",
      input: {
        name: "@openclaw/demo",
        version: "1.2.3",
        resolvedSpec: "@openclaw/demo@1.2.3",
        integrity: "sha512-abc",
        shasum: "deadbeef",
        resolvedAt: "2026-02-22T00:00:00.000Z",
      },
      expected: {
        resolvedName: "@openclaw/demo",
        resolvedVersion: "1.2.3",
        resolvedSpec: "@openclaw/demo@1.2.3",
        integrity: "sha512-abc",
        shasum: "deadbeef",
        resolvedAt: "2026-02-22T00:00:00.000Z",
      },
    },
    {
      name: "returns undefined fields when resolution is missing",
      input: undefined,
      expected: {
        resolvedName: undefined,
        resolvedVersion: undefined,
        resolvedSpec: undefined,
        integrity: undefined,
        shasum: undefined,
        resolvedAt: undefined,
      },
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(buildNpmResolutionInstallFields(input)).toEqual(expected);
  });
});

describe("recordPluginInstall", () => {
  it("stores install metadata for the plugin id", () => {
    const next = recordPluginInstall({}, { pluginId: "demo", source: "npm", spec: "demo@latest" });
    expectRecordedInstall("demo", next);
  });
});
