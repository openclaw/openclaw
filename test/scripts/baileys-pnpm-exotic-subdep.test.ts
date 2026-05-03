import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type RootPackageManifest = {
  pnpm?: {
    overrides?: Record<string, string>;
  };
};

function readRootPackageManifest(): RootPackageManifest {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
  ) as RootPackageManifest;
}

function readRootLockfile(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "pnpm-lock.yaml"), "utf8");
}

describe("Baileys pnpm dependency guardrail", () => {
  it("keeps Baileys libsignal on a registry resolution for block-exotic-subdeps installs", () => {
    const manifest = readRootPackageManifest();
    const lockfile = readRootLockfile();

    expect(manifest.pnpm?.overrides).toMatchObject({
      "@whiskeysockets/baileys@7.0.0-rc.9>libsignal": "2.0.1",
    });
    expect(lockfile).toContain("'@whiskeysockets/baileys@7.0.0-rc.9>libsignal': 2.0.1");
    expect(lockfile).toContain("libsignal: 2.0.1");
    expect(lockfile).toContain("libsignal@2.0.1:");
    expect(lockfile).not.toContain("@whiskeysockets/libsignal-node@https://codeload.github.com");
  });
});
