import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNodeStartupTlsEnvironment } from "./node-startup-env.js";

const GENERIC_CA_BUNDLE_PATH = "/etc/ssl/ca-bundle.pem";
afterEach(() => vi.restoreAllMocks());
const VERSION_MANAGER_EXEC_PATHS = [
  ["fnm", "/home/test/.fnm/node-versions/v22/installation/bin/node"],
  ["fnm XDG data", "/home/test/.local/share/fnm/node-versions/v22/installation/bin/node"],
  ["nvs dotted home", "/home/test/.nvs/node/22.14.0/x64/bin/node"],
  ["volta", "/home/test/.volta/tools/image/node/22.14.0/bin/node"],
  ["asdf", "/home/test/.asdf/installs/nodejs/22.14.0/bin/node"],
  ["mise", "/home/test/.local/share/mise/installs/node/22.14.0/bin/node"],
  ["n", "/home/test/.n/bin/node"],
  ["nodenv", "/home/test/.nodenv/versions/22.14.0/bin/node"],
  ["nodebrew", "/home/test/.nodebrew/node/v22.14.0/bin/node"],
  ["nvs", "/home/test/nvs/node/22.14.0/x64/bin/node"],
  ["raw path before normalization", "/home/test/.nvm/../system/bin/node"],
] as const;

function allowOnly(path: string) {
  return (candidate: Parameters<typeof fs.accessSync>[0]) => {
    if (candidate !== path) {
      throw new Error("ENOENT");
    }
  };
}

describe("Node startup Linux CA defaults", () => {
  it.each(VERSION_MANAGER_EXEC_PATHS)("detects %s via execPath", (_manager, execPath) => {
    vi.spyOn(fs, "accessSync").mockImplementation(allowOnly(GENERIC_CA_BUNDLE_PATH));
    expect(
      resolveNodeStartupTlsEnvironment({
        env: {},
        platform: "linux",
        execPath,
      }).NODE_EXTRA_CA_CERTS,
    ).toBe(GENERIC_CA_BUNDLE_PATH);
  });

  it("keeps NODE_EXTRA_CA_CERTS when it is already set", () => {
    expect(
      resolveNodeStartupTlsEnvironment({
        env: {
          NVM_DIR: "/home/test/.nvm",
          NODE_EXTRA_CA_CERTS: "/custom/ca.pem",
        },
        platform: "linux",
      }).NODE_EXTRA_CA_CERTS,
    ).toBe("/custom/ca.pem");
  });

  it.each([
    ["/usr/bin/node", " \t "],
    ["/home/test/.NVM/versions/node/v22/bin/node", undefined],
    ["/home/test/library/application support/fnm/bin/node", undefined],
    ["/home/test/.local/share/pnpm/node", undefined],
    ["/home/test/.nvm\\versions\\node\\v22\\bin\\node", undefined],
  ] as const)("does not infer Linux CA settings for %s with NVM_DIR=%j", (execPath, NVM_DIR) => {
    expect(
      resolveNodeStartupTlsEnvironment({
        env: { NVM_DIR },
        platform: "linux",
        execPath,
      }).NODE_EXTRA_CA_CERTS,
    ).toBeUndefined();
  });
});
