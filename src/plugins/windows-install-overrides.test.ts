import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  overrides?: Record<string, string>;
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as T;
}

describe("npm install overrides", () => {
  it("pins libsignal to an HTTPS tarball for npm installs", () => {
    const rootManifest = readJson<PackageManifest>("package.json");
    const libsignalOverride = rootManifest.overrides?.libsignal;

    expect(libsignalOverride).toBe(
      "https://codeload.github.com/whiskeysockets/libsignal-node/tar.gz/1c30d7d7e76a3b0aa120b04dc6a26f5a12dccf67",
    );
    expect(libsignalOverride).not.toContain("git@github.com");
    expect(libsignalOverride).not.toContain("ssh://git@github.com");
  });
});
