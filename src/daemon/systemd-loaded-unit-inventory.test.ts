import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import { assertManagedGatewayArtifactPublication } from "../cli/update-cli/update-command-service-revalidation.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { ExecResult } from "./exec-file.js";
import type { GatewayServiceState } from "./service-types.js";
import * as gatewayService from "./service.js";
import * as systemdServiceFiles from "./systemd-service-files.js";

const systemctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execSystemctl>());
const userctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execSystemctlUser>());
vi.mock("./systemd-exec.js", () => ({ execSystemctl: systemctl, execSystemctlUser: userctl }));

import { discoverManagedGatewayBindings } from "./managed-gateway-bindings.js";
import { listLoadedSystemdUnits } from "./systemd-loaded-unit-inventory.js";

const success = (stdout: string): ExecResult => ({
  code: 0,
  termination: "exit",
  stdout,
  stderr: "",
});
const execStart =
  "{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/openclaw/dist/entry.js gateway ; }";
const buses = {
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/user-bus",
  DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/fixture/system-bus",
};
const unitProperties = (name: string, fragmentPath: string) =>
  `Id=${name}\nFragmentPath=${fragmentPath}\nExecStart=${execStart}\nActiveState=active\n`;
const listEntry = (name: string) => success(`${name} loaded active running Gateway\n`);

function withFixture(work: (home: string) => Promise<void>) {
  return withTestDir({ prefix: "openclaw-loaded-unit-" }, async (home) => {
    userctl.mockResolvedValue(success(""));
    systemctl.mockResolvedValue(success(""));
    vi.spyOn(fs, "readdir").mockResolvedValue([]);
    await work(home).finally(() => vi.restoreAllMocks());
  });
}
const withLinuxFixture = (work: (home: string) => Promise<void>) =>
  withMockedPlatform("linux", () => withFixture(work));
const publication = (root: string, env: Record<string, string>) =>
  assertManagedGatewayArtifactPublication({
    roots: [root],
    env,
    timeoutMs: 5_000,
    assertCurrent() {},
    updateInstallKind: "package",
    shouldRestart: true,
  });

beforeEach(() => {
  systemctl.mockReset();
  userctl.mockReset();
});

it("rejects partial loaded-unit properties", async () => {
  const name = "custom-rescue.service";
  systemctl.mockImplementation(async (args) =>
    args.includes("list-units")
      ? listEntry(name)
      : success("Id=unrelated.service\nFragmentPath=\nActiveState=active\n"),
  );
  await expect(
    listLoadedSystemdUnits("system", {
      DBUS_SYSTEM_BUS_ADDRESS: buses.DBUS_SYSTEM_BUS_ADDRESS,
    }),
  ).rejects.toThrow("properties could not be inspected");
});

it.each(
  (["user", "system"] as const).flatMap((scope) =>
    [false, true].map((uncertain) => ({ scope, uncertain })),
  ),
)("preserves cleanup custody: $scope uncertain=$uncertain", ({ scope, uncertain }) =>
  withLinuxFixture(async (home) => {
    const failure = uncertain
      ? new CommandProcessCleanupError()
      : new Error("Synthetic service inventory unavailable");
    const native = scope === "user" ? userctl : systemctl;
    native.mockRejectedValue(failure);
    const publishing = publication(home, { HOME: home, ...buses });
    if (uncertain) {
      await expect(publishing).rejects.toBe(failure);
    } else {
      await expect(publishing).resolves.toBeUndefined();
    }
    expect(native).toHaveBeenCalled();
  }),
);

it.skipIf(process.platform !== "linux")("binds removed custom-profile units", () =>
  withFixture(async (home) => {
    const name = "openclaw-gateway-rescue.service";
    const removedPath = path.join(home, name);
    userctl.mockImplementation(async (_env, args) =>
      args.includes("list-units") ? listEntry(name) : success(unitProperties(name, removedPath)),
    );
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      XDG_CONFIG_DIRS: home,
      XDG_DATA_DIRS: home,
      XDG_RUNTIME_DIR: home,
      ...buses,
    };
    expect(await listLoadedSystemdUnits("user", env)).toEqual([
      { name, fragmentPath: removedPath, execStart },
    ]);
    expect(await discoverManagedGatewayBindings(env, { requireComplete: true })).toEqual([
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_SYSTEMD_UNIT: name }),
        systemdReadTarget: { scope: "user", unitName: name, unitPath: removedPath },
      }),
    ]);
    const checkout = path.join(home, "checkout");
    await fs.mkdir(path.join(checkout, "dist"), { recursive: true });
    await fs.writeFile(path.join(checkout, "package.json"), '{"name":"openclaw"}\n');
    await fs.writeFile(path.join(checkout, "dist/index.js"), "gateway\n");
    const command = {
      programArguments: [process.execPath, path.join(checkout, "dist/index.js"), "gateway"],
      sourcePath: removedPath,
    };
    vi.spyOn(systemdServiceFiles, "readSystemdServiceCommandLocation").mockImplementation(
      async (_env, target) =>
        target?.unitName === name ? { kind: "command", command } : { kind: "not-loaded" },
    );
    vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: true,
      env: {},
      command,
    } satisfies GatewayServiceState);
    const writes = vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("unexpected write"));
    await expect(
      resolveLiveManagedGatewayDistFence(checkout, { env, requireVerified: true }),
    ).resolves.toMatchObject({ refuse: true });
    await expect(publication(checkout, env)).rejects.toThrow(
      `another managed Gateway (systemd user unit ${JSON.stringify(name)})`,
    );
    expect(writes).not.toHaveBeenCalled();
  }),
);

it.each([false, true])("fences possible managers (present=%s)", (present) =>
  withLinuxFixture(async (home) => {
    vi.spyOn(fs, "lstat").mockRejectedValue(
      Object.assign(new Error("Synthetic path absent"), { code: "ENOENT" }),
    );
    for (const native of [userctl, systemctl]) {
      native.mockRejectedValue(new Error("Synthetic advertised manager inaccessible"));
    }
    const env = {
      HOME: home,
      XDG_RUNTIME_DIR: home,
      ...(present ? { DBUS_SESSION_BUS_ADDRESS: buses.DBUS_SESSION_BUS_ADDRESS } : {}),
    };
    await expect(
      resolveLiveManagedGatewayDistFence(home, { env, requireVerified: true }),
    ).resolves.toMatchObject({ refuse: present });
  }),
);
