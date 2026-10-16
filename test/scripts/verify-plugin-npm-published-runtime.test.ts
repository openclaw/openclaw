// Verify Plugin Npm Published Runtime tests cover verify plugin npm published runtime script behavior.
import { describe, expect, it } from "vitest";
import {
  collectPluginNpmPublishedRuntimeErrors,
  findPackedPackageReadmePath,
  parseVerifyPublishedPluginRuntimeArgs,
  parseNpmReadmeMetadata,
  readPluginNpmCommandOptions,
  resolveNpmPackFilename,
  runPluginNpmCommand,
  usage,
} from "../../scripts/verify-plugin-npm-published-runtime.mts";

describe("plugin npm publish verifier args", () => {
  it("parses help and package specs before npm calls", () => {
    expect(parseVerifyPublishedPluginRuntimeArgs(["--help"])).toEqual({ help: true, spec: "" });
    expect(parseVerifyPublishedPluginRuntimeArgs(["--", "@openclaw/discord@2026.5.2"])).toEqual({
      help: false,
      spec: "@openclaw/discord@2026.5.2",
    });
  });

  it("rejects unknown and extra args before npm calls", () => {
    expect(() => parseVerifyPublishedPluginRuntimeArgs([])).toThrow(usage());
    expect(() => parseVerifyPublishedPluginRuntimeArgs(["--wat"])).toThrow(
      "Unknown plugin npm verifier option: --wat",
    );
    expect(() =>
      parseVerifyPublishedPluginRuntimeArgs(["@openclaw/discord@2026.5.2", "extra"]),
    ).toThrow("Unexpected plugin npm verifier argument: extra");
  });
});

describe("plugin npm publish verifier command limits", () => {
  it("rejects loose npm command timeout and buffer overrides", () => {
    for (const value of ["60s", "1e3", "0"]) {
      expect(() =>
        readPluginNpmCommandOptions({ OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS: value }),
      ).toThrow(`invalid OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS: ${value}`);
    }
    expect(() =>
      readPluginNpmCommandOptions({
        OPENCLAW_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: "16mb",
      }),
    ).toThrow("invalid OPENCLAW_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: 16mb");
  });

  it("runs npm metadata commands with bounded exec options", () => {
    const calls: unknown[] = [];
    const output = runPluginNpmCommand(["view", "@openclaw/discord", "readme"], {
      env: {
        OPENCLAW_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: "1024",
        OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS: "2500",
      },
      execFileSyncImpl(command: string, args: string[], options: unknown) {
        calls.push({ args, command, options });
        return JSON.stringify("# Discord");
      },
    });

    expect(output).toBe(JSON.stringify("# Discord"));
    expect(calls).toStrictEqual([
      {
        args: ["view", "@openclaw/discord", "readme"],
        command: "npm",
        options: {
          encoding: "utf8",
          killSignal: "SIGKILL",
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 2500,
        },
      },
    ]);
  });
});

describe("collectPluginNpmPublishedRuntimeErrors", () => {
  it("rejects test and fixture files from the publication artifact", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "runtime-entry-fixture",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: [
          "package.json",
          "openclaw.plugin.json",
          "dist/index.js",
          "dist/runtime.test-harness.js",
          "skills/example/src/index.ts",
          "src/index.ts",
          "src/__fixtures__/plugin.ts",
          "src/test-support/helper.ts",
          "test/pack.test.ts",
          "root.test.ts",
        ],
      }),
    ).toEqual([
      "runtime-entry-fixture plugin npm package must not include test or fixture files: root.test.ts, src/__fixtures__/plugin.ts, src/test-support/helper.ts, test/pack.test.ts",
    ]);
  });

  it("reports a missing later JavaScript entry alongside valid JavaScript and TypeScript entries", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "runtime-entry-fixture",
          openclaw: { extensions: ["./first.js", "./second.mjs", "./third.cts"] },
        },
        files: ["package.json", "openclaw.plugin.json", "first.js", "dist/third.cjs"],
      }),
    ).toEqual(["runtime-entry-fixture runtime extension entry not found: ./second.mjs"]);
  });

  it("flags reservation packages before they can pass plugin runtime verification", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/tavily-plugin",
          version: "0.0.0",
          description: "Bootstrap reservation",
        },
        files: ["package.json", "README.md"],
      }),
    ).toEqual([
      "@openclaw/tavily-plugin@0.0.0 plugin npm package must include openclaw.plugin.json",
    ]);
  });

  it("flags runtimeExtensions length mismatches", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/acpx",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./index.ts", "./tools.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: ["package.json", "openclaw.plugin.json", "dist/index.js"],
      }),
    ).toEqual([
      "@openclaw/acpx@2026.5.3 package.json openclaw.runtimeExtensions length (1) must match openclaw.extensions length (2)",
    ]);
  });

  it("flags blank runtimeExtensions entries instead of falling back to inferred outputs", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/whatsapp",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./src/index.ts"],
            runtimeExtensions: [" "],
          },
        },
        files: ["package.json", "openclaw.plugin.json", "src/index.ts", "dist/index.js"],
      }),
    ).toEqual([
      "@openclaw/whatsapp@2026.5.3 package.json openclaw.runtimeExtensions[0] must be a non-empty string",
    ]);
  });

  it("flags published plugin packages with TypeScript setup entries and no compiled setup runtime", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/line",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            setupEntry: "./setup-entry.ts",
          },
        },
        files: [
          "package.json",
          "openclaw.plugin.json",
          "index.ts",
          "dist/index.js",
          "setup-entry.ts",
        ],
      }),
    ).toEqual([
      "@openclaw/line@2026.5.3 requires compiled runtime output for TypeScript entry ./setup-entry.ts: expected ./dist/setup-entry.js, ./dist/setup-entry.mjs, ./dist/setup-entry.cjs, ./setup-entry.js, ./setup-entry.mjs, ./setup-entry.cjs",
    ]);
  });

  it("flags missing explicit runtimeSetupEntry outputs", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/matrix",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            setupEntry: "./setup-entry.ts",
            runtimeSetupEntry: "./dist/setup-entry.js",
          },
        },
        files: ["package.json", "openclaw.plugin.json", "dist/index.js"],
      }),
    ).toEqual(["@openclaw/matrix@2026.5.3 runtime setup entry not found: ./dist/setup-entry.js"]);
  });

  it("flags runtimeSetupEntry without setupEntry", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/twitch",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            runtimeSetupEntry: "./dist/setup-entry.js",
          },
        },
        files: ["package.json", "openclaw.plugin.json", "dist/index.js", "dist/setup-entry.js"],
      }),
    ).toEqual([
      "@openclaw/twitch@2026.5.3 package.json openclaw.runtimeSetupEntry requires openclaw.setupEntry",
    ]);
  });
});

describe("resolveNpmPackFilename", () => {
  it("uses the final tarball filename from plain npm pack output", () => {
    const noisyOutput = [
      "npm notice",
      "npm notice package: @openclaw/msteams@2026.5.24-beta.1",
      "openclaw-msteams-2026.5.24-beta.1.tgz",
      "",
    ].join("\n");

    expect(resolveNpmPackFilename(noisyOutput)).toBe("openclaw-msteams-2026.5.24-beta.1.tgz");
  });

  it("rejects path-like tarball output instead of reading outside the pack directory", () => {
    const unsafeOutputs = [
      "../openclaw-msteams.tgz",
      "nested/openclaw-msteams.tgz",
      "nested\\openclaw-msteams.tgz",
      "/tmp/openclaw-msteams.tgz",
      "C:\\temp\\openclaw-msteams.tgz",
      "openclaw-msteams\u0000.tgz",
    ];

    for (const output of unsafeOutputs) {
      expect(() => resolveNpmPackFilename(output)).toThrow(
        "npm pack did not report a tarball filename",
      );
    }
  });
});

describe("findPackedPackageReadmePath", () => {
  it("finds a root package README without accepting nested documentation files", () => {
    expect(
      findPackedPackageReadmePath(["package.json", "docs/README.md", "README.md", "dist/index.js"]),
    ).toBe("README.md");
    expect(findPackedPackageReadmePath(["package.json", "docs/README.md"])).toBe("");
  });
});

describe("parseNpmReadmeMetadata", () => {
  it("accepts non-empty npm string readme metadata", () => {
    expect(parseNpmReadmeMetadata(JSON.stringify("# Plugin\n\nInstall it."))).toBe(
      "# Plugin\n\nInstall it.",
    );
  });

  it("rejects empty or unsupported npm readme metadata", () => {
    expect(parseNpmReadmeMetadata(JSON.stringify(""))).toBe("");
    expect(parseNpmReadmeMetadata(JSON.stringify(null))).toBe("");
    expect(parseNpmReadmeMetadata(JSON.stringify([]))).toBe("");
    expect(parseNpmReadmeMetadata(JSON.stringify(["# One", "# Two"]))).toBe("");
    expect(parseNpmReadmeMetadata("{")).toBe("");
  });
});
