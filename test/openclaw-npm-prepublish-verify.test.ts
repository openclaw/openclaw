import { describe, expect, it } from "vitest";
import {
  openClawNpmPrepublishVerifyUsage,
  parseOpenClawNpmPrepublishVerifyArgs,
} from "../scripts/openclaw-npm-prepublish-verify.ts";

describe("parseOpenClawNpmPrepublishVerifyArgs", () => {
  it("supports help, optional versions, and package-manager separators", () => {
    expect(parseOpenClawNpmPrepublishVerifyArgs(["--help"])).toEqual({
      help: true,
      tarballPath: "",
    });
    expect(parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz"])).toEqual({
      help: false,
      tarballPath: "openclaw.tgz",
    });
    expect(parseOpenClawNpmPrepublishVerifyArgs(["--", "openclaw.tgz", "2026.3.23"])).toEqual({
      expectedVersion: "2026.3.23",
      help: false,
      tarballPath: "openclaw.tgz",
    });
  });

  it("rejects missing, option-like, and extra arguments before installing", () => {
    expect(() => parseOpenClawNpmPrepublishVerifyArgs([])).toThrow(
      openClawNpmPrepublishVerifyUsage(),
    );
    expect(() => parseOpenClawNpmPrepublishVerifyArgs(["--tag"])).toThrow(
      "Unknown openclaw npm prepublish verifier option: --tag",
    );
    expect(() => parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "--tag"])).toThrow(
      "Unknown openclaw npm prepublish verifier option: --tag",
    );
    expect(() =>
      parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "2026.3.23", "extra"]),
    ).toThrow("Unexpected openclaw npm prepublish verifier argument: extra");
  });
});
