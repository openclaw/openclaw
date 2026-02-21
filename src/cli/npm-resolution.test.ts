import { describe, expect, it } from "vitest";
import {
  buildNpmInstallRecordFields,
  logPinnedNpmSpecMessages,
  mapNpmResolutionMetadata,
  resolvePinnedNpmSpec,
} from "./npm-resolution.js";

describe("npm-resolution helpers", () => {
  it("keeps original spec when pin is disabled", () => {
    const result = resolvePinnedNpmSpec({
      rawSpec: "@openclaw/plugin-alpha@latest",
      pin: false,
      resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
    });
    expect(result).toEqual({
      recordSpec: "@openclaw/plugin-alpha@latest",
    });
  });

  it("warns when pin is enabled but resolved spec is missing", () => {
    const result = resolvePinnedNpmSpec({
      rawSpec: "@openclaw/plugin-alpha@latest",
      pin: true,
    });
    expect(result).toEqual({
      recordSpec: "@openclaw/plugin-alpha@latest",
      pinWarning: "Could not resolve exact npm version for --pin; storing original npm spec.",
    });
  });

  it("returns pinned spec notice when resolved spec is available", () => {
    const result = resolvePinnedNpmSpec({
      rawSpec: "@openclaw/plugin-alpha@latest",
      pin: true,
      resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
    });
    expect(result).toEqual({
      recordSpec: "@openclaw/plugin-alpha@1.2.3",
      pinNotice: "Pinned npm install record to @openclaw/plugin-alpha@1.2.3.",
    });
  });

  it("maps npm resolution metadata to install fields", () => {
    expect(
      mapNpmResolutionMetadata({
        name: "@openclaw/plugin-alpha",
        version: "1.2.3",
        resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
        integrity: "sha512-abc",
        shasum: "deadbeef",
        resolvedAt: "2026-02-21T00:00:00.000Z",
      }),
    ).toEqual({
      resolvedName: "@openclaw/plugin-alpha",
      resolvedVersion: "1.2.3",
      resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
      integrity: "sha512-abc",
      shasum: "deadbeef",
      resolvedAt: "2026-02-21T00:00:00.000Z",
    });
  });

  it("builds common npm install record fields", () => {
    expect(
      buildNpmInstallRecordFields({
        spec: "@openclaw/plugin-alpha@1.2.3",
        installPath: "/tmp/openclaw/extensions/alpha",
        version: "1.2.3",
        resolution: {
          name: "@openclaw/plugin-alpha",
          version: "1.2.3",
          resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
          integrity: "sha512-abc",
        },
      }),
    ).toEqual({
      source: "npm",
      spec: "@openclaw/plugin-alpha@1.2.3",
      installPath: "/tmp/openclaw/extensions/alpha",
      version: "1.2.3",
      resolvedName: "@openclaw/plugin-alpha",
      resolvedVersion: "1.2.3",
      resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
      integrity: "sha512-abc",
      shasum: undefined,
      resolvedAt: undefined,
    });
  });

  it("logs pin warning/notice messages through provided writers", () => {
    const logs: string[] = [];
    const warns: string[] = [];
    logPinnedNpmSpecMessages(
      {
        pinWarning: "warn-1",
        pinNotice: "notice-1",
      },
      (message) => logs.push(message),
      (message) => warns.push(message),
    );

    expect(logs).toEqual(["notice-1"]);
    expect(warns).toEqual(["warn-1"]);
  });
});
