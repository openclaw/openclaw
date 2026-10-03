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

import { listManagedOpenClawGatewayServices } from "./inspect.js";
import { discoverManagedGatewayBindings } from "./managed-gateway-bindings.js";
import { listLoadedSystemdUnits } from "./systemd-loaded-unit-inventory.js";

const success = (stdout: string): ExecResult => ({
  code: 0,
  termination: "exit",
  stdout,
  stderr: "",
});

beforeEach(() => {
  systemctl.mockReset();
  userctl.mockReset();
});

it("finds a running Gateway whose system unit file is gone", async () => {
  systemctl.mockImplementation(async (args) =>
    args.includes("list-units")
      ? success("custom-rescue.service loaded active running custom Gateway\n")
      : success(
          "Id=custom-rescue.service\n" +
            "FragmentPath=/etc/systemd/system/custom-rescue.service\n" +
            "ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/openclaw/dist/entry.js gateway ; }\n" +
            "ActiveState=active\n",
        ),
  );

  await expect(
    listLoadedSystemdUnits("system", { DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/fixture/bus" }),
  ).resolves.toEqual([
    {
      name: "custom-rescue.service",
      fragmentPath: "/etc/systemd/system/custom-rescue.service",
      execStart:
        "{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/openclaw/dist/entry.js gateway ; }",
    },
  ]);
  expect(systemctl).toHaveBeenCalledTimes(2);
  expect(systemctl.mock.calls[1]?.[0]).toContain(
    "--property=Id,FragmentPath,ExecStart,ActiveState",
  );
});

it("refuses a partial loaded-unit reply", async () => {
  systemctl.mockImplementation(async (args) =>
    args.includes("list-units")
      ? success("custom-rescue.service loaded active running custom Gateway\n")
      : success("Id=unrelated.service\nFragmentPath=\nActiveState=active\n"),
  );

  await expect(
    listLoadedSystemdUnits("system", { DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/fixture/bus" }),
  ).rejects.toThrow("properties could not be inspected");
});

it.each(
  (["user", "system"] as const).flatMap((scope) =>
    [false, true].map((uncertain) => ({ scope, uncertain })),
  ),
)("preserves publication cleanup custody: $scope uncertain=$uncertain", ({ scope, uncertain }) =>
  withMockedPlatform("linux", () =>
    withTestDir({ prefix: "openclaw-loaded-cleanup-" }, async (home) => {
      const failure = uncertain
        ? new CommandProcessCleanupError()
        : new Error("Synthetic service inventory unavailable");
      userctl.mockResolvedValue(success(""));
      systemctl.mockResolvedValue(success(""));
      const native = scope === "user" ? userctl : systemctl;
      native.mockRejectedValue(failure);
      const directories = vi.spyOn(fs, "readdir").mockResolvedValue([]);
      try {
        const publication = assertManagedGatewayArtifactPublication({
          roots: [home],
          env: {
            HOME: home,
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/user-bus",
            DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/fixture/system-bus",
          },
          timeoutMs: 5_000,
          assertCurrent() {},
          updateInstallKind: "package",
          shouldRestart: true,
        });
        if (uncertain) {
          await expect(publication).rejects.toBe(failure);
        } else {
          await expect(publication).resolves.toBeUndefined();
        }
        expect(native).toHaveBeenCalled();
      } finally {
        directories.mockRestore();
      }
    }),
  ),
);

it.skipIf(process.platform !== "linux")(
  "binds a running custom-profile Gateway after its unit file is removed",
  async () => {
    await withTestDir({ prefix: "openclaw-loaded-unit-" }, async (home) => {
      const name = "openclaw-gateway-rescue.service";
      const removedPath = path.join(home, name);
      const execStart =
        "{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/openclaw/dist/entry.js gateway ; }";
      userctl.mockImplementation(async (_env, args) =>
        args.includes("list-units")
          ? success(`${name} loaded active running Gateway\n`)
          : success(
              `Id=${name}\nFragmentPath=${removedPath}\nExecStart=${execStart}\nActiveState=active\n`,
            ),
      );
      systemctl.mockResolvedValue(success(""));
      const directories = vi.spyOn(fs, "readdir").mockResolvedValue([]);
      try {
        const env = {
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
          XDG_CONFIG_DIRS: home,
          XDG_DATA_DIRS: home,
          XDG_RUNTIME_DIR: home,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/user-bus",
          DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/fixture/system-bus",
        };
        expect(await listLoadedSystemdUnits("user", env)).toEqual([
          { name, fragmentPath: removedPath, execStart },
        ]);
        const inventory = await listManagedOpenClawGatewayServices(env, { requireComplete: true });
        expect(inventory.errors).toEqual([]);
        expect(inventory.services).toEqual([
          expect.objectContaining({
            label: name,
            detail: `unit: ${removedPath}`,
            scope: "user",
          }),
        ]);
        const bindings = await discoverManagedGatewayBindings(env, { requireComplete: true });
        expect(bindings).toEqual([
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
        const location = vi
          .spyOn(systemdServiceFiles, "readSystemdServiceCommandLocation")
          .mockImplementation(async (_env, target) =>
            target?.unitName === name ? { kind: "command", command } : { kind: "not-loaded" },
          );
        const state = vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue({
          installed: true,
          loadState: { status: "loaded" },
          running: true,
          env: {},
          command,
        } satisfies GatewayServiceState);
        const writes = vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("unexpected write"));
        try {
          await expect(
            resolveLiveManagedGatewayDistFence(checkout, { env, requireVerified: true }),
          ).resolves.toMatchObject({ refuse: true });
          await expect(
            assertManagedGatewayArtifactPublication({
              roots: [checkout],
              env,
              timeoutMs: 5_000,
              assertCurrent() {},
              updateInstallKind: "package",
              shouldRestart: true,
            }),
          ).rejects.toThrow(`another managed Gateway (systemd user unit ${JSON.stringify(name)})`);
          expect(writes).not.toHaveBeenCalled();
        } finally {
          writes.mockRestore();
          state.mockRestore();
          location.mockRestore();
        }
      } finally {
        directories.mockRestore();
      }
    });
  },
);
