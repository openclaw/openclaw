import { describe, expect, it } from "vitest";
import {
  isNvmNode,
  LINUX_CA_BUNDLE_PATHS,
  resolveAutoNodeExtraCaCerts,
  resolveLinuxSystemCaBundle,
} from "./node-extra-ca-certs.js";

function allowOnly(path: string) {
  return (candidate: string) => {
    if (candidate !== path) {
      throw new Error("ENOENT");
    }
  };
}

describe("resolveLinuxSystemCaBundle", () => {
  it("returns undefined on non-linux platforms", () => {
    expect(
      resolveLinuxSystemCaBundle({
        platform: "darwin",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[0]),
      }),
    ).toBeUndefined();
  });

  it("returns the first readable Linux CA bundle", () => {
    expect(
      resolveLinuxSystemCaBundle({
        platform: "linux",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[1]),
      }),
    ).toBe(LINUX_CA_BUNDLE_PATHS[1]);
  });
});

describe("isNvmNode", () => {
  it("detects nvm via NVM_DIR", () => {
    expect(isNvmNode({ NVM_DIR: "/home/test/.nvm" }, "/usr/bin/node")).toBe(true);
  });

  it("detects nvm via execPath", () => {
    expect(isNvmNode({}, "/home/test/.nvm/versions/node/v22/bin/node")).toBe(true);
  });

  it("returns false for non-nvm node paths", () => {
    expect(isNvmNode({}, "/usr/bin/node")).toBe(false);
  });
});

describe("resolveAutoNodeExtraCaCerts", () => {
  it("returns undefined when NODE_EXTRA_CA_CERTS is already set", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: {
          NVM_DIR: "/home/test/.nvm",
          NODE_EXTRA_CA_CERTS: "/custom/ca.pem",
        },
        platform: "linux",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[0]),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when node is not nvm-managed", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: {},
        platform: "linux",
        execPath: "/usr/bin/node",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[0]),
      }),
    ).toBeUndefined();
  });

  it("returns the readable Linux CA bundle for nvm-managed node", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: { NVM_DIR: "/home/test/.nvm" },
        platform: "linux",
        execPath: "/usr/bin/node",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[2]),
      }),
    ).toBe(LINUX_CA_BUNDLE_PATHS[2]);
  });
});
