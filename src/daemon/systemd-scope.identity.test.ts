import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findInstalledSystemdGatewayScope, isNonFatalSystemdInstallProbeError } from "./systemd.js";

const findServices = vi.hoisted(() =>
  vi.fn<typeof import("./inspect.js").findSystemGatewayServices>(async () => []),
);
vi.mock("./inspect.js", () => ({ findSystemGatewayServices: () => findServices() }));
const HOME = "/tmp/openclaw-test-home";
const systemPath = (name: string) => `/etc/systemd/system/${name}.service`;
let files: string[];

function marker(name: string) {
  findServices.mockResolvedValueOnce([
    {
      platform: "linux",
      label: `${name}.service`,
      detail: `unit: ${systemPath(name)}`,
      sourcePath: systemPath(name),
      scope: "system",
      marker: "openclaw",
    },
  ]);
}

beforeEach(() => {
  files = [];
  findServices.mockReset().mockResolvedValue([]);
  vi.spyOn(fs, "access").mockImplementation(async (file) => {
    if (!files.includes(String(file))) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });
});
afterEach(() => vi.restoreAllMocks());

it("selects marker-owned, legacy, and explicitly requested units (openclaw#119648)", async () => {
  const cases = [
    { profile: undefined, override: undefined, name: "openclaw", discovered: true },
    { profile: "lisa", override: undefined, name: "openclaw-lisa", discovered: false },
    { profile: "lisa", override: "openclaw-node", name: "openclaw-node", discovered: false },
    {
      profile: "lisa",
      override: "openclaw-gateway-lisa",
      name: "openclaw-gateway-lisa",
      user: true,
    },
  ];
  for (const { profile, override, name, discovered, user } of cases) {
    const unitPath = user ? `${HOME}/.config/systemd/user/${name}.service` : systemPath(name);
    files = discovered ? [] : [unitPath];
    if (discovered) {
      marker(name);
    }
    await expect(
      findInstalledSystemdGatewayScope({
        HOME,
        OPENCLAW_PROFILE: profile,
        OPENCLAW_SYSTEMD_UNIT: override,
      }),
    ).resolves.toEqual({ scope: user ? "user" : "system", unitName: `${name}.service`, unitPath });
  }
});

it("refuses marker units outside the selected profile or explicit identity", async () => {
  const cases = [
    ["lisa", undefined, "openclaw-darlene"],
    ["Lisa", undefined, "openclaw-gateway-lisa"],
    [undefined, undefined, "my-custom-gateway"],
    [undefined, "my-gateway", "my-gateway@"],
    [undefined, "my-gateway", "my-gateway@gateway"],
    [undefined, "openclaw@gateway.service", "openclaw@other"],
    [undefined, "openclaw-node", "openclaw-darlene"],
  ] as const;
  for (const [profile, override, name] of cases) {
    marker(name);
    await expect(
      findInstalledSystemdGatewayScope({
        HOME,
        OPENCLAW_PROFILE: profile,
        OPENCLAW_SYSTEMD_UNIT: override,
      }),
    ).resolves.toBeNull();
  }
});

it("rejects legacy aliases that collide with Node or another canonical profile", async () => {
  files = ["openclaw-node", "openclaw-gateway", "openclaw-gateway-lisa"].map(
    (name) => `${HOME}/.config/systemd/user/${name}.service`,
  );
  for (const profile of ["node", "gateway", "gateway-lisa"]) {
    await expect(
      findInstalledSystemdGatewayScope({ HOME, OPENCLAW_PROFILE: profile }),
    ).resolves.toBeNull();
  }
});

it.each(["disk", "marker"])(
  "preserves an explicit instance with only its template on %s",
  async (source) => {
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "unrelated-login",
      uid: 1000,
      gid: 1000,
      homedir: HOME,
      shell: "/bin/sh",
    });
    if (source === "disk") {
      files = [systemPath("openclaw@")];
    } else {
      marker("openclaw@");
    }
    await expect(
      findInstalledSystemdGatewayScope({
        HOME,
        OPENCLAW_SYSTEMD_UNIT: "openclaw@gateway.service",
      }),
    ).resolves.toEqual({
      scope: "system",
      unitName: "openclaw@gateway.service",
      unitPath: systemPath("openclaw@"),
    });
  },
);

it("classifies unavailable install probes without hiding infrastructure failures", () => {
  for (const [message, expected] of [
    ["Command failed: systemctl --user is-enabled openclaw-gateway.service", true],
    ["systemctl is-enabled unavailable: Failed to connect to bus", true],
    ["systemctl is-enabled unavailable: read-only file system", false],
  ] as const) {
    expect(isNonFatalSystemdInstallProbeError(new Error(message))).toBe(expected);
  }
});
