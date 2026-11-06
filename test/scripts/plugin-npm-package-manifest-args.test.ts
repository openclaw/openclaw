import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRunArgs } from "../../scripts/lib/plugin-npm-package-manifest.mts";

const usage =
  "usage: node scripts/lib/plugin-npm-package-manifest.mjs --run <package-dir> [--clawhub-metadata <package-dir> | --qa-gateway-fixture] -- <command> [args...]";

describe("plugin-npm-package-manifest run args", () => {
  it("returns help before resolving package dirs", () => {
    expect(parseRunArgs(["--help"])).toEqual({
      help: true,
      packageDir: "",
      command: "",
      args: [],
    });
  });

  it("selects private fixture metadata without consuming callback arguments", () => {
    expect(
      parseRunArgs([
        "--run",
        "extensions/qa-channel",
        "--qa-gateway-fixture",
        "--",
        "node",
        "",
        "--literal",
      ]),
    ).toEqual({
      packageDir: "extensions/qa-channel",
      profile: "qa-gateway-fixture",
      command: "node",
      args: ["", "--literal"],
    });
  });

  it("binds an explicit ClawHub metadata source without treating it as a command argument", () => {
    expect(
      parseRunArgs([
        "--run",
        "extensions/demo",
        "--clawhub-metadata",
        "tooling/extensions/demo",
        "--",
        "clawhub",
        "package",
        "pack",
      ]),
    ).toEqual({
      packageDir: "extensions/demo",
      clawhubMetadataDir: resolve("tooling/extensions/demo"),
      command: "clawhub",
      args: ["package", "pack"],
    });
    expect(() =>
      parseRunArgs(["--run", "extensions/demo", "--clawhub-metadata", "--", "npm", "pack"]),
    ).toThrow("unexpected plugin npm package manifest run argument");
  });

  it("rejects missing or option-looking package dirs", () => {
    expect(() => parseRunArgs(["--run"])).toThrow(usage);
    expect(() => parseRunArgs(["--run", "--", "npm", "pack"])).toThrow(usage);
    expect(() => parseRunArgs(["--run", "--bad", "--", "npm", "pack"])).toThrow(usage);
  });
});
