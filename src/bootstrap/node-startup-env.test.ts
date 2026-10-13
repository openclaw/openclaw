import { describe, expect, it } from "vitest";
import { resolveNodeStartupTlsEnvironment } from "./node-startup-env.js";

const FEDORA_CA_BUNDLE_PATH = "/etc/pki/tls/certs/ca-bundle.crt";

function allowOnly(path: string) {
  return (candidate: string) => {
    if (candidate !== path) {
      throw new Error("ENOENT");
    }
  };
}

describe("resolveNodeStartupTlsEnvironment", () => {
  it("keeps user-provided env values byte-for-byte", () => {
    expect(
      resolveNodeStartupTlsEnvironment({
        env: {
          NODE_EXTRA_CA_CERTS: " /custom/ca.pem ",
          NODE_USE_SYSTEM_CA: "0",
        },
        platform: "darwin",
      }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: " /custom/ca.pem ",
      NODE_USE_SYSTEM_CA: "0",
    });
  });

  it.each([
    ["empty Linux value", "", "linux", FEDORA_CA_BUNDLE_PATH, undefined],
    ["whitespace macOS value", " \t ", "darwin", "/etc/ssl/cert.pem", "1"],
  ] as const)("treats %s as unset", (_label, value, platform, expected, systemCa) => {
    const startupEnv = resolveNodeStartupTlsEnvironment({
      env: { NODE_EXTRA_CA_CERTS: value, NVM_DIR: "/home/test/.nvm" },
      platform,
      execPath: "/usr/bin/node",
      accessSync: allowOnly(FEDORA_CA_BUNDLE_PATH),
    });

    expect(startupEnv).toEqual({
      NODE_EXTRA_CA_CERTS: expected,
      NODE_USE_SYSTEM_CA: systemCa,
    });
  });

  it("can skip macOS defaults for CLI-only pre-start planning", () => {
    expect(
      resolveNodeStartupTlsEnvironment({
        env: { NVM_DIR: "/home/test/.nvm" },
        platform: "darwin",
        includeDarwinDefaults: false,
        accessSync: allowOnly(FEDORA_CA_BUNDLE_PATH),
      }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: undefined,
      NODE_USE_SYSTEM_CA: undefined,
    });
  });
});
