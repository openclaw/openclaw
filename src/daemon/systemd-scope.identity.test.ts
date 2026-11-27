import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ServiceOwnershipRefusalError,
  SystemdServiceAccountRefusalError,
  type SystemdServiceAccountMismatch,
} from "./service-inspection-error.js";
import { findInstalledSystemdGatewayScope, isNonFatalSystemdInstallProbeError } from "./systemd.js";

const findServices = vi.hoisted(() =>
  vi.fn<typeof import("./inspect.js").findSystemGatewayServices>(async () => []),
);
vi.mock("./inspect.js", () => ({ findSystemGatewayServices: () => findServices() }));
const readCommand = vi.hoisted(() => ({ refusal: undefined as Error | undefined }));
vi.mock("./systemd-service-files.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./systemd-service-files.js")>();
  return {
    ...original,
    readSystemdServiceExecStart: (
      ...args: Parameters<typeof original.readSystemdServiceExecStart>
    ) =>
      readCommand.refusal
        ? Promise.reject(readCommand.refusal)
        : original.readSystemdServiceExecStart(...args),
  };
});
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
  readCommand.refusal = undefined;
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
  ["system", "EACCES"],
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

type Source = "user" | "system" | "marker" | "aliases";
type SelectionCase = [string | undefined, string | undefined, string, Source, boolean?, string?];
const template = "openclaw@gateway.service";
const nodeName = "openclaw-node-work";
const aliases = ["openclaw-node", "openclaw-gateway", "openclaw-gateway-lisa"].map(userPath);
const selectionCases: SelectionCase[] = [
  [undefined, undefined, "openclaw", "marker"],
  ["lisa", undefined, "openclaw-lisa", "system"],
  ["lisa", "openclaw-node", "openclaw-node", "system"],
  ["lisa", "openclaw-gateway-lisa", "openclaw-gateway-lisa", "user"],
  [undefined, template, "openclaw@", "system"],
  [undefined, template, "openclaw@", "marker"],
  ["lisa", undefined, "openclaw-darlene", "marker", false],
  ["Lisa", undefined, "openclaw-gateway-lisa", "marker", false],
  [undefined, undefined, "my-custom-gateway", "marker", false],
  [undefined, "my-gateway", "my-gateway@", "marker", false],
  [undefined, "my-gateway", "my-gateway@gateway", "marker", false],
  [undefined, template, "openclaw@other", "marker", false],
  [undefined, "openclaw-node", "openclaw-darlene", "marker", false],
  ["node", undefined, "", "aliases", false],
  ["gateway", undefined, "", "aliases", false],
  ["gateway-lisa", undefined, "", "aliases", false],
  ...(["user", "system"] as const).flatMap((scope): SelectionCase[] => [
    ["node-work", undefined, nodeName, scope, true, "gateway"],
    ["node-work", undefined, nodeName, scope, false, "node"],
    ["work", nodeName, nodeName, scope, true, "node"],
  ]),
];
it.each(selectionCases)(
  "selects only the owned identity: profile=%s override=%s name=%s source=%s found=%s kind=%s",
  async (profile, override, name, source, found, kind) => {
    if (name === "openclaw@") {
      const account = { username: "other", uid: 1000, gid: 1000, homedir: HOME, shell: "/bin/sh" };
      vi.spyOn(os, "userInfo").mockReturnValue(account);
    }
    const scope = source === "user" ? "user" : "system";
    const unitPath = (scope === "user" ? userPath : systemPath)(name);
    files = source === "aliases" ? aliases : source === "marker" ? [] : [unitPath];
    if (source === "marker") {
      marker(name);
    }
    if (kind) {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        `[Service]\nEnvironment=OPENCLAW_SERVICE_KIND=${kind}\n`,
      );
    }
    const selected = {
      scope,
      unitName: name === "openclaw@" ? template : `${name}.service`,
      unitPath,
    };
    await expect(findScope(profile, override)).resolves.toEqual(found !== false ? selected : null);
  },
);

const skippedUnit: SystemdServiceAccountMismatch = {
  unitName: "company-gateway.service",
  unitPath: systemPath("company-gateway"),
  serviceUser: "openclaw",
  programArguments: ["/usr/bin/node", "/usr/lib/node_modules/openclaw/dist/index.js", "gateway"],
  workingDirectory: "",
  selectors: { HOME: "/var/lib/openclaw" },
  selectorsIncomplete: false,
};
it.each([
  [new SystemdServiceAccountRefusalError(skippedUnit), [skippedUnit]],
  [new ServiceOwnershipRefusalError("systemd-account-refused"), []],
])(
  "still skips a custom unit run by another account and reports what it saw",
  async (refusal, expected) => {
    readCommand.refusal = refusal;
    marker("company-gateway");
    const reported: SystemdServiceAccountMismatch[] = [];
    // Custom names are considered only for the default installation of this account.
    const env = { HOME: os.userInfo().homedir };

    await expect(
      findInstalledSystemdGatewayScope(env, { onAccountMismatch: (seen) => reported.push(seen) }),
    ).resolves.toBeNull();
    expect(reported).toEqual(expected);
  },
);

it("accepts legacy command-failure install probes", () => {
  expect(
    isNonFatalSystemdInstallProbeError(
      new Error("Command failed: systemctl --user is-enabled openclaw-gateway.service"),
    ),
  ).toBe(true);
});
