import { describe, expect, it } from "vitest";
import { parseArgs as parseBulkBuildArgs } from "../../scripts/check-plugin-npm-runtime-builds.mts";
import { parseArgs as parseSingleBuildArgs } from "../../scripts/lib/plugin-npm-runtime-build.mts";

describe("plugin npm runtime build args", () => {
  it("parses explicit plugin package build targets", () => {
    expect(
      parseBulkBuildArgs(["--package", "extensions/slack", "--package", "extensions/telegram"]),
    ).toEqual({
      packageDirs: ["extensions/slack", "extensions/telegram"],
    });
    expect(parseSingleBuildArgs(["extensions/slack"])).toEqual({
      packageDir: "extensions/slack",
    });
    expect(parseSingleBuildArgs(["--", "extensions/slack"])).toEqual({
      packageDir: "extensions/slack",
    });
  });

  it("returns help before resolving build targets", () => {
    expect(parseBulkBuildArgs(["--help"])).toEqual({
      help: true,
      packageDirs: [],
    });
    expect(parseSingleBuildArgs(["--help"])).toEqual({
      help: true,
      packageDir: "",
    });
  });

  it("selects preparation without compilation only when explicitly requested", () => {
    for (const args of [
      ["--prepare-native-import", "extensions/slack"],
      ["extensions/slack", "--prepare-native-import"],
      ["--", "--prepare-native-import", "extensions/slack"],
    ]) {
      expect(parseSingleBuildArgs(args)).toEqual({
        packageDir: "extensions/slack",
        prepareNativeImport: true,
      });
    }
    expect(() => parseSingleBuildArgs(["--prepare-native-import"])).toThrow(/usage:/u);
    expect(() => parseSingleBuildArgs(["--prepare-native-import", "--unknown"])).toThrow(/usage:/u);
    expect(() =>
      parseSingleBuildArgs(["--prepare-native-import", "extensions/slack", "extra"]),
    ).toThrow(/unexpected/u);
  });

  it.each([
    { argv: ["extensions/slack", ""] },
    { argv: ["extensions/slack", " \t "] },
    { argv: ["extensions/slack", "", "extra"] },
    { argv: ["extensions/slack", "", "--unexpected"] },
    { argv: ["--", "extensions/slack", ""] },
    { argv: ["--prepare-native-import", "extensions/slack", ""] },
    { argv: ["extensions/slack", "", "--prepare-native-import"] },
    { argv: ["extensions/slack", "--prepare-native-import", "", "--unexpected"] },
    { argv: ["--", "--prepare-native-import", "extensions/slack", ""] },
    { argv: ["--prepare-native-import", "extensions/slack", "", "--prepare-native-import"] },
  ])("rejects excess runtime build argv $argv after extracting its mode", ({ argv }) => {
    expect(() => parseSingleBuildArgs(argv)).toThrow(
      "unexpected plugin npm runtime build argument",
    );
  });

  it("preserves help, literal targets, and the bulk builder's separate grammar", () => {
    expect(parseSingleBuildArgs(["--", "--help", ""])).toEqual({ help: true, packageDir: "" });
    expect(parseSingleBuildArgs(["--prepare-native-import", "--help"])).toEqual({
      help: true,
      packageDir: "",
    });
    expect(parseSingleBuildArgs([" extensions/slack "])).toEqual({
      packageDir: " extensions/slack ",
    });
    expect(parseSingleBuildArgs(["--", "extensions/slack", "--prepare-native-import"])).toEqual({
      packageDir: "extensions/slack",
      prepareNativeImport: true,
    });
    expect(() => parseBulkBuildArgs(["--package", "extensions/slack", ""])).toThrow(/usage:/u);
    expect(() => parseBulkBuildArgs(["--package", ""])).toThrow("missing value for --package");
  });

  it("rejects missing or option-looking package targets", () => {
    expect(() => parseBulkBuildArgs(["--package"])).toThrow("missing value for --package");
    expect(() => parseBulkBuildArgs(["--package", "--package", "extensions/slack"])).toThrow(
      "missing value for --package",
    );
    expect(() => parseBulkBuildArgs(["--package", "-h"])).toThrow("missing value for --package");
    expect(() => parseSingleBuildArgs(["--package"])).toThrow(
      "usage: node scripts/lib/plugin-npm-runtime-build.mjs <package-dir>",
    );
    expect(() => parseSingleBuildArgs(["extensions/slack", "extra"])).toThrow(
      "unexpected plugin npm runtime build argument: extra",
    );
  });
});
