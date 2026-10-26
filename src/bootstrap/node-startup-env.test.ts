import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNodeStartupTlsEnvironment } from "./node-startup-env.js";
import { allowOnly } from "./node-startup-env.test-support.js";

const FEDORA_CA_BUNDLE_PATH = "/etc/pki/tls/certs/ca-bundle.crt";
afterEach(() => vi.restoreAllMocks());

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
    ["whitespace macOS value", " \t ", "darwin", undefined, "1"],
  ] as const)("treats %s as unset", (_label, value, platform, expected, systemCa) => {
    vi.spyOn(fs, "accessSync").mockImplementation(allowOnly(FEDORA_CA_BUNDLE_PATH));
    const startupEnv = resolveNodeStartupTlsEnvironment({
      env: { NODE_EXTRA_CA_CERTS: value, NVM_DIR: "/home/test/.nvm" },
      platform,
      execPath: "/usr/bin/node",
    });

    expect(startupEnv).toEqual({
      NODE_EXTRA_CA_CERTS: expected,
      NODE_USE_SYSTEM_CA: systemCa,
    });
  });

  it("drops the legacy darwin CA bundle value on every caller", () => {
    for (const includeDarwinDefaults of [undefined, false]) {
      expect(
        resolveNodeStartupTlsEnvironment({
          env: { NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem" },
          platform: "darwin",
          includeDarwinDefaults,
        }),
      ).toEqual({
        NODE_EXTRA_CA_CERTS: undefined,
        NODE_USE_SYSTEM_CA: includeDarwinDefaults === false ? undefined : "1",
      });
    }
  });

  it("can skip macOS defaults for CLI-only pre-start planning", () => {
    expect(
      resolveNodeStartupTlsEnvironment({
        env: { NVM_DIR: "/home/test/.nvm" },
        platform: "darwin",
        includeDarwinDefaults: false,
      }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: undefined,
      NODE_USE_SYSTEM_CA: undefined,
    });
  });
});
