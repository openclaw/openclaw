import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  evaluateRuntimeEligibility,
  hasBinary,
  isConfigPathTruthyWithDefaults,
  prepareBinaryAvailability,
} from "./config-eval.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const truthy = (config: unknown, key: string) => isConfigPathTruthyWithDefaults(config, key, {});
const prepared = async (bin = "fixture-tool") =>
  (await prepareBinaryAvailability([bin])).hasBinary(bin);
function setup(platform?: "linux" | "win32") {
  if (platform) {
    mockProcessPlatform(platform);
  }
  const root = tempDirs.make("openclaw-binary-");
  vi.stubEnv("PATH", root);
  vi.stubEnv("PATHEXT", ".EXE;.CMD");
  return root;
}
function install(executable: string) {
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(executable, 0o755);
}

describe.each([
  ["synchronous", hasBinary],
  ["prepared", prepared],
] as const)("%s binary lookup", (_name, probe) => {
  it("skips directories and finds a later executable", async () => {
    const root = setup();
    const [first, second] = [path.join(root, "first"), path.join(root, "second")];
    fs.mkdirSync(path.join(first, "fixture-tool"), { recursive: true });
    fs.mkdirSync(second);
    vi.stubEnv("PATH", [first, second].join(path.delimiter));
    expect(await probe("fixture-tool")).toBe(false);
    install(path.join(second, `fixture-tool${process.platform === "win32" ? ".CMD" : ""}`));
    expect(await probe("fixture-tool")).toBe(true);
  });
  it.skipIf(process.platform === "win32")("follows executable symlinks", async () => {
    const root = setup();
    const executable = path.join(root, "installed-tool");
    install(executable);
    fs.symlinkSync(executable, path.join(root, "fixture-tool"));
    expect(await probe("fixture-tool")).toBe(true);
  });
});

it("normalizes primitive values and resolves nested config paths", () => {
  for (const [value, expected] of [
    [undefined, false],
    [null, false],
    [false, false],
    [true, true],
    [0, false],
    [1, true],
    ["   ", false],
    [" ok ", true],
    [{}, true],
  ] as const) {
    expect(truthy({ value }, "value")).toBe(expected);
  }
  const config = { browser: { enabled: true, nested: { count: 1 } } };
  expect(
    ["browser.enabled", ".browser..nested.count.", "browser.missing.value"].map((key) =>
      truthy(config, key),
    ),
  ).toEqual([true, true, false]);
  expect(truthy("not-an-object", "browser.enabled")).toBe(false);
});

it("blocks prototype traversal and inherited defaults", () => {
  expect(truthy({ safe: { enabled: true } }, "safe.enabled")).toBe(true);
  for (const key of [
    "__proto__",
    "constructor.name",
    "prototype.polluted",
    "constructor",
    "__proto__.enabled",
    "prototype.enabled",
  ]) {
    expect(truthy({}, key)).toBe(false);
  }
});

it("invalidates Windows hits when PATHEXT changes", () => {
  install(path.join(setup("win32"), "tool.CMD"));
  expect(hasBinary("tool")).toBe(true);
  vi.stubEnv("PATHEXT", ".EXE");
  expect(hasBinary("tool")).toBe(false);
  vi.stubEnv("PATHEXT", ".CMD");
  expect(hasBinary("tool")).toBe(true);
});

it.each(["linux", "win32"] as const)("rechecks misses on unchanged %s PATH", (platform) => {
  const root = setup(platform);
  expect(hasBinary("fixture-tool")).toBe(false);
  install(path.join(root, `fixture-tool${platform === "win32" ? ".CMD" : ""}`));
  expect(hasBinary("fixture-tool")).toBe(true);
});

it("prepared facts observe installation and removal independently of cached hits", async () => {
  const root = setup("linux");
  vi.stubEnv("PATH", [path.join(root, "missing"), root].join(path.delimiter));
  const executable = path.join(root, "fixture-tool");
  expect(await prepared()).toBe(false);
  install(executable);
  expect(hasBinary("fixture-tool")).toBe(true);
  expect(await prepared()).toBe(true);
  fs.unlinkSync(executable);
  expect(await prepared()).toBe(false);
  expect(hasBinary("fixture-tool")).toBe(true);
  vi.stubEnv("PATH", path.join(root, "other"));
  expect(hasBinary("fixture-tool")).toBe(false);
});

it("preserves nested binary names", async () => {
  const root = setup();
  const bin = path.join("nested", "fixture-tool");
  install(path.join(root, bin));
  expect(await prepared(bin)).toBe(true);
  expect(hasBinary(bin)).toBe(true);
});

it("bounds environment reads across PATH and PATHEXT candidates", async () => {
  const root = setup("win32");
  vi.stubEnv(
    "PATH",
    Array.from({ length: 30 }, (_, i) => path.join(root, `missing-${i}`)).join(path.delimiter),
  );
  vi.stubEnv("PATHEXT", ".EXE;.CMD;.BAT;.COM");
  const cwd = vi.spyOn(process, "cwd");
  const facts = await prepareBinaryAvailability(["missing-tool-a", "missing-tool-b"]);
  expect([facts.hasBinary("missing-tool-a"), facts.hasBinary("missing-tool-b")]).toEqual([
    false,
    false,
  ]);
  expect(cwd.mock.calls.length).toBeLessThan(20);
});

it.each([
  { name: "active OS", os: ["darwin"] },
  { name: "always bypass", always: true, requires: { env: ["OPENAI_API_KEY"] } },
  {
    name: "requirements",
    requires: {
      bins: ["node"],
      anyBins: ["bun", "node"],
      env: ["OPENAI_API_KEY"],
      config: ["browser.enabled"],
    },
  },
])("evaluates $name", (options) => {
  mockProcessPlatform("darwin");
  expect(
    evaluateRuntimeEligibility({
      ...options,
      hasBin: (bin) => !options.always && bin === "node",
      hasAnyRemoteBin: () => false,
      hasEnv: (name) => !options.always && name === "OPENAI_API_KEY",
      isConfigPathTruthy: (key) => !options.always && key === "browser.enabled",
    }),
  ).toBe(true);
});
