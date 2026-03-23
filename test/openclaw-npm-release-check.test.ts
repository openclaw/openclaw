import { describe, expect, it } from "vitest";
import {
  collectReleasePackageMetadataErrors,
  collectReleaseTagErrors,
  parseNpmPackJsonOutput,
  parseReleaseTagVersion,
  parseReleaseVersion,
  resolveNpmCommandInvocation,
  utcCalendarDayDistance,
} from "../scripts/openclaw-npm-release-check.ts";

describe("parseReleaseVersion", () => {
  it("parses stable CalVer releases", () => {
    expect(parseReleaseVersion("2026.3.10")).toMatchObject({
      version: "2026.3.10",
      channel: "stable",
      year: 2026,
      month: 3,
      day: 10,
    });
  });

  it("parses beta CalVer releases", () => {
    expect(parseReleaseVersion("2026.3.10-beta.2")).toMatchObject({
      version: "2026.3.10-beta.2",
      channel: "beta",
      year: 2026,
      month: 3,
      day: 10,
      betaNumber: 2,
    });
  });

  it("rejects legacy and malformed release formats", () => {
    expect(parseReleaseVersion("2026.3.10-1")).toBeNull();
    expect(parseReleaseVersion("2026.03.09")).toBeNull();
    expect(parseReleaseVersion("v2026.3.10")).toBeNull();
    expect(parseReleaseVersion("2026.2.30")).toBeNull();
    expect(parseReleaseVersion("2.0.0-beta2")).toBeNull();
  });
});

describe("parseReleaseTagVersion", () => {
  it("accepts fallback correction tags for stable releases", () => {
    expect(parseReleaseTagVersion("2026.3.10-2")).toMatchObject({
      version: "2026.3.10-2",
      packageVersion: "2026.3.10",
      channel: "stable",
      correctionNumber: 2,
    });
  });

  it("rejects beta correction tags and malformed correction tags", () => {
    expect(parseReleaseTagVersion("2026.3.10-beta.1-1")).toBeNull();
    expect(parseReleaseTagVersion("2026.3.10-0")).toBeNull();
  });
});

describe("utcCalendarDayDistance", () => {
  it("compares UTC calendar days rather than wall-clock hours", () => {
    const left = new Date("2026-03-09T23:59:59Z");
    const right = new Date("2026-03-11T00:00:01Z");
    expect(utcCalendarDayDistance(left, right)).toBe(2);
  });
});

describe("resolveNpmCommandInvocation", () => {
  it("uses npm_execpath when it points to npm", () => {
    expect(
      resolveNpmCommandInvocation({
        npmExecPath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
        nodeExecPath: "/usr/local/bin/node",
        platform: "linux",
      }),
    ).toEqual({
      command: "/usr/local/bin/node",
      args: ["/usr/local/lib/node_modules/npm/bin/npm-cli.js"],
    });
  });

  it("falls back to the npm command when npm_execpath points to pnpm", () => {
    expect(
      resolveNpmCommandInvocation({
        npmExecPath: "/home/test/.cache/node/corepack/v1/pnpm/10.23.0/bin/pnpm.cjs",
        nodeExecPath: "/usr/local/bin/node",
        platform: "linux",
      }),
    ).toEqual({
      command: "npm",
      args: [],
    });
  });

  it("uses the platform npm command when npm_execpath is missing", () => {
    expect(resolveNpmCommandInvocation({ platform: "win32" })).toEqual({
      command: "npm.cmd",
      args: [],
    });
  });
});

describe("parseNpmPackJsonOutput", () => {
  it("parses a plain npm pack JSON array", () => {
    expect(parseNpmPackJsonOutput('[{"filename":"openclaw.tgz","files":[]}]')).toEqual([
      { filename: "openclaw.tgz", files: [] },
    ]);
  });

  it("parses the trailing JSON payload after npm lifecycle logs", () => {
    const stdout = [
      'npm warn Unknown project config "node-linker".',
      "",
      "> openclaw@2026.3.23 prepack",
      "> pnpm build && pnpm ui:build",
      "",
      "[copy-hook-metadata] Copied 4 hook metadata files.",
      '[{"filename":"openclaw.tgz","files":[{"path":"dist/control-ui/index.html"}]}]',
    ].join("\n");

    expect(parseNpmPackJsonOutput(stdout)).toEqual([
      {
        filename: "openclaw.tgz",
        files: [{ path: "dist/control-ui/index.html" }],
      },
    ]);
  });

  it("returns null when no JSON payload is present", () => {
    expect(parseNpmPackJsonOutput("> openclaw@2026.3.23 prepack")).toBeNull();
  });
});

describe("collectReleaseTagErrors", () => {
  it("accepts versions within the two-day CalVer window", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10",
        releaseTag: "v2026.3.10",
        now: new Date("2026-03-11T12:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("rejects versions outside the two-day CalVer window", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10",
        releaseTag: "v2026.3.10",
        now: new Date("2026-03-13T00:00:00Z"),
      }),
    ).toContainEqual(expect.stringContaining("must be within 2 days"));
  });

  it("accepts fallback correction tags for stable package versions", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10",
        releaseTag: "v2026.3.10-1",
        now: new Date("2026-03-10T00:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("rejects beta package versions paired with fallback correction tags", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10-beta.1",
        releaseTag: "v2026.3.10-1",
        now: new Date("2026-03-10T00:00:00Z"),
      }),
    ).toContainEqual(expect.stringContaining("does not match package.json version"));
  });
});

describe("collectReleasePackageMetadataErrors", () => {
  it("validates the expected npm package metadata", () => {
    expect(
      collectReleasePackageMetadataErrors({
        name: "openclaw",
        description: "Multi-channel AI gateway with extensible messaging integrations",
        license: "MIT",
        repository: { url: "git+https://github.com/openclaw/openclaw.git" },
        bin: { openclaw: "openclaw.mjs" },
        peerDependencies: { "node-llama-cpp": "3.16.2" },
        peerDependenciesMeta: { "node-llama-cpp": { optional: true } },
      }),
    ).toEqual([]);
  });

  it("requires node-llama-cpp to stay an optional peer", () => {
    expect(
      collectReleasePackageMetadataErrors({
        name: "openclaw",
        description: "Multi-channel AI gateway with extensible messaging integrations",
        license: "MIT",
        repository: { url: "git+https://github.com/openclaw/openclaw.git" },
        bin: { openclaw: "openclaw.mjs" },
        peerDependencies: { "node-llama-cpp": "3.16.2" },
      }),
    ).toContain('package.json peerDependenciesMeta["node-llama-cpp"].optional must be true.');
  });
});
