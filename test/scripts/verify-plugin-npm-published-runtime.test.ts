import { expect, it } from "vitest";
import {
  collectPluginNpmPublishedRuntimeErrors,
  findPackedPackageReadmePath,
  parseVerifyPublishedPluginRuntimeArgs as parseArgs,
  parseNpmReadmeMetadata,
  readPluginNpmCommandOptions,
  resolveNpmPackFilename,
  usage,
} from "../../scripts/verify-plugin-npm-published-runtime.mts";

function runtimeErrors(openclaw: Record<string, unknown>, files: string[], error: string) {
  expect(
    collectPluginNpmPublishedRuntimeErrors({
      packageJson: { name: "runtime-entry-fixture", openclaw },
      files: ["package.json", "openclaw.plugin.json", ...files],
    }),
  ).toEqual([`runtime-entry-fixture ${error}`]);
}

const runtimeExtension = { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] };

it("parses help and package specs before npm calls", () => {
  expect(parseArgs(["--help"])).toEqual({ help: true, spec: "" });
  expect(parseArgs(["--", "@openclaw/discord@1"])).toEqual({
    help: false,
    spec: "@openclaw/discord@1",
  });
});

it("rejects unknown and extra args before npm calls", () => {
  expect(() => parseArgs([])).toThrow(usage());
  expect(() => parseArgs(["--wat"])).toThrow("Unknown plugin npm verifier option: --wat");
  expect(() => parseArgs(["plugin@1", "extra"])).toThrow(
    "Unexpected plugin npm verifier argument: extra",
  );
});

it("rejects a nonpositive npm command budget", () => {
  expect(() =>
    readPluginNpmCommandOptions({ OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS: "0" }),
  ).toThrow("invalid OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS: 0");
});

it("bounds npm metadata commands", () => {
  expect(
    readPluginNpmCommandOptions({
      OPENCLAW_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: "1024",
      OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS: "2500",
    }),
  ).toEqual({
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2500,
  });
});

it("rejects test and fixture files from the publication artifact", () => {
  runtimeErrors(
    runtimeExtension,
    [
      "dist/index.js",
      "dist/runtime.test-harness.js",
      "skills/example/src/index.ts",
      "src/__fixtures__/plugin.ts",
      "root.test.ts",
    ],
    "plugin npm package must not include test or fixture files: root.test.ts, src/__fixtures__/plugin.ts",
  );
});

it("reports a missing later JavaScript entry alongside valid JavaScript and TypeScript entries", () => {
  runtimeErrors(
    { extensions: ["./first.js", "./second.mjs", "./third.cts"] },
    ["first.js", "dist/third.cjs"],
    "runtime extension entry not found: ./second.mjs",
  );
});

it("flags reservation packages before they can pass plugin runtime verification", () => {
  expect(
    collectPluginNpmPublishedRuntimeErrors({
      packageJson: {
        name: "reservation",
        version: "0.0.0",
      },
      files: ["package.json", "README.md"],
    }),
  ).toEqual(["reservation@0.0.0 plugin npm package must include openclaw.plugin.json"]);
});

it.each([
  [
    { extensions: ["./index.ts", "./tools.ts"], runtimeExtensions: ["./dist/index.js"] },
    ["dist/index.js"],
    "package.json openclaw.runtimeExtensions length (1) must match openclaw.extensions length (2)",
  ],
  [
    { extensions: ["./src/index.ts"], runtimeExtensions: [" "] },
    ["src/index.ts", "dist/index.js"],
    "package.json openclaw.runtimeExtensions[0] must be a non-empty string",
  ],
  [
    { ...runtimeExtension, setupEntry: "./setup-entry.ts" },
    ["index.ts", "dist/index.js", "setup-entry.ts"],
    "requires compiled runtime output for TypeScript entry ./setup-entry.ts: expected ./dist/setup-entry.js, ./dist/setup-entry.mjs, ./dist/setup-entry.cjs, ./setup-entry.js, ./setup-entry.mjs, ./setup-entry.cjs",
  ],
  [
    {
      ...runtimeExtension,
      setupEntry: "./setup-entry.ts",
      runtimeSetupEntry: "./dist/setup-entry.js",
    },
    ["dist/index.js"],
    "runtime setup entry not found: ./dist/setup-entry.js",
  ],
  [
    { ...runtimeExtension, runtimeSetupEntry: "./dist/setup-entry.js" },
    ["dist/index.js", "dist/setup-entry.js"],
    "package.json openclaw.runtimeSetupEntry requires openclaw.setupEntry",
  ],
] satisfies Array<[Record<string, unknown>, string[], string]>)(
  "rejects invalid runtime entries (%#)",
  (openclaw, files, error) => {
    runtimeErrors(openclaw, files, error);
  },
);

it("uses the final tarball filename from plain npm pack output", () => {
  expect(resolveNpmPackFilename("npm notice\nplugin.tgz\n")).toBe("plugin.tgz");
});

it("rejects path-like tarball output instead of reading outside the pack directory", () => {
  const unsafeOutputs = ["../plugin.tgz", "nested\\plugin.tgz", "plugin\u0000.tgz"];

  for (const output of unsafeOutputs) {
    expect(() => resolveNpmPackFilename(output)).toThrow(
      "npm pack did not report a tarball filename",
    );
  }
});

it("finds a root package README without accepting nested documentation files", () => {
  expect(findPackedPackageReadmePath(["docs/README.md", "README.md"])).toBe("README.md");
  expect(findPackedPackageReadmePath(["package.json", "docs/README.md"])).toBe("");
});

it("accepts non-empty npm string readme metadata", () => {
  expect(parseNpmReadmeMetadata(JSON.stringify("# Plugin"))).toBe("# Plugin");
});

it("rejects empty or unsupported npm readme metadata", () => {
  expect(parseNpmReadmeMetadata(JSON.stringify(""))).toBe("");
  expect(parseNpmReadmeMetadata(JSON.stringify(null))).toBe("");
  expect(parseNpmReadmeMetadata(JSON.stringify([]))).toBe("");
  expect(parseNpmReadmeMetadata(JSON.stringify(["# One", "# Two"]))).toBe("");
  expect(parseNpmReadmeMetadata("{")).toBe("");
});
