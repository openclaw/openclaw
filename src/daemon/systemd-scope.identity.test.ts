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
const userPath = (name: string) => `${HOME}/.config/systemd/user/${name}.service`;
const findScope = (profile?: string, override?: string) =>
  findInstalledSystemdGatewayScope({
    HOME,
    OPENCLAW_PROFILE: profile,
    OPENCLAW_SYSTEMD_UNIT: override,
  });
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

it.each([
  ["user", "EACCES"],
  ["user", "EIO"],
  ["system", "EACCES"],
  ["system", "EIO"],
])("reports %s unit inspection failure %s instead of absence", async (scope, code) => {
  const unitPath = (scope === "user" ? userPath : systemPath)("openclaw-gateway");
  const inspectionError = Object.assign(new Error("unit inspection failed"), { code });
  vi.spyOn(fs, "access").mockImplementation(async (file) => {
    throw String(file) === unitPath
      ? inspectionError
      : Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });

  await expect(findScope()).rejects.toBe(inspectionError);
});

it.each([
  [undefined, undefined, "openclaw", "marker"],
  ["lisa", undefined, "openclaw-lisa", "system"],
  ["lisa", "openclaw-node", "openclaw-node", "system"],
  ["lisa", "openclaw-gateway-lisa", "openclaw-gateway-lisa", "user"],
  [undefined, "openclaw@gateway.service", "openclaw@", "system"],
  [undefined, "openclaw@gateway.service", "openclaw@", "marker"],
] as const)("selects %s / %s from %s / %s (#119648)", async (profile, override, name, source) => {
  if (name === "openclaw@") {
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "unrelated-login",
      uid: 1000,
      gid: 1000,
      homedir: HOME,
      shell: "/bin/sh",
    });
  }
  const scope = source === "user" ? "user" : "system";
  const unitPath = (scope === "user" ? userPath : systemPath)(name);
  files = source === "marker" ? [] : [unitPath];
  if (source === "marker") {
    marker(name);
  }
  await expect(findScope(profile, override)).resolves.toEqual({
    scope,
    unitName: name === "openclaw@" ? "openclaw@gateway.service" : `${name}.service`,
    unitPath,
  });
});

it.each([
  ["lisa", undefined, "openclaw-darlene"],
  ["Lisa", undefined, "openclaw-gateway-lisa"],
  [undefined, undefined, "my-custom-gateway"],
  [undefined, "my-gateway", "my-gateway@"],
  [undefined, "my-gateway", "my-gateway@gateway"],
  [undefined, "openclaw@gateway.service", "openclaw@other"],
  [undefined, "openclaw-node", "openclaw-darlene"],
] as const)("rejects foreign marker %s / %s / %s", async (profile, override, name) => {
  marker(name);
  await expect(findScope(profile, override)).resolves.toBeNull();
});

it.each(["node", "gateway", "gateway-lisa"])("rejects legacy alias %s", async (profile) => {
  files = ["openclaw-node", "openclaw-gateway", "openclaw-gateway-lisa"].map(userPath);
  await expect(findScope(profile)).resolves.toBeNull();
});

it.each(["user", "system"] as const)(
  "distinguishes a profile node from a legacy Gateway in %s scope",
  async (scope) => {
    const unitPath = (scope === "user" ? userPath : systemPath)("openclaw-node-work");
    files = [unitPath];
    const read = vi.spyOn(fs, "readFile");
    read.mockResolvedValue("[Service]\nEnvironment=OPENCLAW_SERVICE_KIND=gateway\n");
    await expect(findScope("node-work")).resolves.toMatchObject({ unitPath, scope });
    read.mockResolvedValue("[Service]\nEnvironment=OPENCLAW_SERVICE_KIND=node\n");
    await expect(findScope("node-work")).resolves.toBeNull();
    await expect(findScope("work", "openclaw-node-work")).resolves.toMatchObject({
      unitPath,
      scope,
    });
  },
);

it.each([
  ["Command failed: systemctl --user is-enabled openclaw-gateway.service", true],
  ["systemctl is-enabled unavailable: Failed to connect to bus", true],
  ["systemctl is-enabled unavailable: read-only file system", false],
] as const)("classifies install probe %s as nonfatal=%s", (message, expected) => {
  expect(isNonFatalSystemdInstallProbeError(new Error(message))).toBe(expected);
});
