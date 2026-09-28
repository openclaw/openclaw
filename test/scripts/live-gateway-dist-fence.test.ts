import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import * as gatewayBindings from "../../src/daemon/managed-gateway-bindings.js";
import type { ManagedGatewayBinding } from "../../src/daemon/managed-gateway-bindings.js";
import * as schtasksExec from "../../src/daemon/schtasks-exec.js";
import * as schtasksProbe from "../../src/daemon/schtasks-state-probe.js";
import * as serviceLayout from "../../src/daemon/service-layout.js";
import type { GatewayServiceState } from "../../src/daemon/service-types.ts";
import * as gatewayService from "../../src/daemon/service.js";
import { withTestDir } from "../../src/test-helpers/temp-dir.js";
import { withMockedPlatform } from "../../src/test-utils/vitest-spies.js";

function baseState(overrides: Partial<GatewayServiceState> = {}): GatewayServiceState {
  return {
    installed: true,
    loadState: { status: "loaded" },
    running: false,
    env: {},
    command: {
      programArguments: [
        "/usr/bin/node",
        "/srv/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
    },
    ...overrides,
  };
}

async function inspectFixtureGateway(
  root: string,
  fixture: {
    env?: NodeJS.ProcessEnv;
    listBindings?: () => Promise<readonly ManagedGatewayBinding[]>;
    readState: (
      binding: ManagedGatewayBinding,
      input: Parameters<typeof gatewayService.readGatewayServiceState>[1],
    ) => Promise<GatewayServiceState>;
  },
) {
  const discover = vi
    .spyOn(gatewayBindings, "discoverManagedGatewayBindings")
    .mockImplementation(async () => [...((await fixture.listBindings?.()) ?? [])]);
  const read = vi
    .spyOn(gatewayService, "readGatewayServiceState")
    .mockImplementation(async (_service, input = {}) => {
      const env = input.env ?? {};
      const target = input.systemdReadTarget;
      return fixture.readState(
        {
          profile: env.OPENCLAW_PROFILE ?? "default",
          env,
          ...(target ? { scope: target.scope, systemdReadTarget: target } : {}),
        },
        input,
      );
    });
  onTestFinished(() => {
    read.mockRestore();
    discover.mockRestore();
  });
  return resolveLiveManagedGatewayDistFence(root, { env: fixture.env ?? {} });
}

function stateForPackage(root: string, overrides: Partial<GatewayServiceState> = {}) {
  return baseState({
    command: {
      programArguments: [process.execPath, path.join(root, "dist", "index.js"), "gateway"],
    },
    ...overrides,
  });
}

describe("live-gateway-dist-fence", () => {
  it.each([
    { name: "running", state: { running: true } },
    {
      name: "holding cgroup tasks",
      state: { runtime: { status: "unknown", state: "failed", systemd: { tasksCurrent: 2 } } },
    },
  ])("allows builds when the $name managed Gateway uses another checkout", async ({ state }) => {
    await withTestDir({ prefix: "openclaw-live-dist-foreign-" }, async (tmp) => {
      const other = path.join(tmp, "other");
      await writeOpenClawPackage(tmp);
      await writeOpenClawPackage(other);
      expect(
        await inspectFixtureGateway(tmp, {
          readState: async () => stateForPackage(other, state),
        }),
      ).toEqual({ refuse: false });
    });
  });

  it("requests the loaded command before comparing the serving dist", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-loaded-" }, async (tmp) => {
      const savedDefinition = path.join(tmp, "saved-definition");
      await writeOpenClawPackage(tmp);
      await writeOpenClawPackage(savedDefinition);
      const result = await inspectFixtureGateway(tmp, {
        readState: async (_binding, input) =>
          stateForPackage(
            input?.requireEffective && input.requireLoadedCommand ? tmp : savedDefinition,
            { running: true },
          ),
      });
      expect(result.refuse).toBe(true);
    });
  });

  it.each([
    { name: "stopped", runtime: { status: "stopped", state: "inactive" }, refuse: false },
    ...(["inactive", "failed"] as const).flatMap((state) => [
      {
        name: `${state} with remaining cgroup tasks and no MainPID`,
        runtime: { status: "unknown", state, systemd: { tasksCurrent: 2 } },
        refuse: true,
      },
      {
        name: `${state} with zero cgroup tasks`,
        runtime: { status: "stopped", state, systemd: { tasksCurrent: 0 } },
        refuse: false,
      },
      {
        name: `${state} with an unavailable cgroup task count`,
        runtime: { status: "unknown", state, systemd: {} },
        refuse: false,
      },
    ]),
    {
      name: "deactivating without a MainPID",
      runtime: { status: "stopped", state: "deactivating", subState: "stop-post" },
      refuse: true,
    },
    {
      name: "deactivating with a live MainPID",
      runtime: {
        status: "stopped",
        state: "deactivating",
        subState: "stop-sigterm",
        pid: process.pid,
      },
      refuse: true,
    },
  ])("classifies a matching $name service using its native state", async ({ runtime, refuse }) => {
    await withTestDir({ prefix: "openclaw-live-dist-state-" }, async (tmp) => {
      await writeOpenClawPackage(tmp);
      const result = await inspectFixtureGateway(tmp, {
        readState: async () => stateForPackage(tmp, { runtime }),
      });
      expect(result.refuse).toBe(refuse);
    });
  });

  it.each([
    { code: "EPERM", refuse: true },
    { code: "ESRCH", refuse: false },
  ])("distinguishes a $code PID probe when matching dist", async ({ code, refuse }) => {
    await withTestDir({ prefix: "openclaw-live-dist-pid-" }, async (tmp) => {
      await writeOpenClawPackage(tmp);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error(`synthetic ${code}`), { code });
      });
      onTestFinished(() => kill.mockRestore());
      const result = await inspectFixtureGateway(tmp, {
        readState: async () =>
          stateForPackage(tmp, {
            runtime: { status: "stopped", state: "inactive", pid: process.pid },
          }),
      });
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(process.pid, 0);
      expect(result.refuse).toBe(refuse);
    });
  });

  it("names the running Gateway and recovery commands in its refusal", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-message-" }, async (tmp) => {
      await writeOpenClawPackage(tmp);
      const result = await inspectFixtureGateway(tmp, {
        readState: async () =>
          stateForPackage(tmp, {
            running: true,
            runtime: {
              status: "running",
              pid: process.pid,
              systemd: { unit: "openclaw-gateway.service" },
            },
          }),
      });
      expect(result.refuse).toBe(true);
      if (result.refuse) {
        expect(result.message).toContain(path.join(tmp, "dist", "index.js"));
        expect(result.message).toContain("openclaw-gateway.service");
        expect(result.message).toContain("openclaw update");
      }
    });
  });

  it("fails open when service inspection throws", async () => {
    expect(
      await inspectFixtureGateway("/synthetic/openclaw", {
        readState: async () => {
          throw new Error("no service manager");
        },
      }),
    ).toEqual({ refuse: false });
  });

  it("fails open when layout inspection throws after reading a service", async () => {
    const layout = vi
      .spyOn(serviceLayout, "summarizeGatewayServiceLayout")
      .mockRejectedValue(new Error("realpath failed"));
    onTestFinished(() => layout.mockRestore());
    expect(
      await inspectFixtureGateway("/synthetic/openclaw", {
        readState: async () => baseState({ running: true }),
      }),
    ).toEqual({ refuse: false });
  });
});

async function writeOpenClawPackage(packageRoot: string) {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"openclaw"}\n');
  await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "gateway\n");
}

function isolateSystemdInventory(home: string) {
  const systemRoots = ["/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"];
  const fixturePath = (value: string) => {
    const normalized = path.normalize(value);
    return systemRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
      ? path.join(home, "native", normalized.slice(1))
      : value;
  };
  const readdir = fs.readdir;
  const readFile = fs.readFile;
  const directories = vi
    .spyOn(fs, "readdir")
    .mockImplementation((...args: Parameters<typeof fs.readdir>) => {
      if (typeof args[0] === "string") {
        args[0] = fixturePath(args[0]);
      }
      return readdir(...args);
    });
  const files = vi
    .spyOn(fs, "readFile")
    .mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (typeof args[0] === "string") {
        args[0] = fixturePath(args[0]);
      }
      return readFile(...args);
    });
  onTestFinished(() => {
    files.mockRestore();
    directories.mockRestore();
  });
  return fixturePath;
}

describe("live-gateway-dist-fence physical overlap", () => {
  it.each([
    { entry: "src/entry.ts", distPresent: true, refuse: false },
    { entry: "openclaw.mjs", distPresent: true, refuse: true },
    { entry: "openclaw.mjs", distPresent: false, refuse: false },
    { entry: "dist/index.js", distPresent: false, refuse: false },
  ])(
    "distinguishes dist use by a live $entry command (dist present: $distPresent)",
    async ({ entry, distPresent, refuse }) => {
      await withTestDir({ prefix: "openclaw-live-dist-entry-" }, async (tmp) => {
        await writeOpenClawPackage(tmp);
        const entrypoint = path.join(tmp, entry);
        await fs.mkdir(path.dirname(entrypoint), { recursive: true });
        await fs.writeFile(entrypoint, "// synthetic service entrypoint\n");
        if (!distPresent) {
          await fs.rm(path.join(tmp, "dist"), { recursive: true });
        }
        const result = await inspectFixtureGateway(tmp, {
          readState: async () =>
            baseState({
              running: true,
              command: {
                programArguments: [process.execPath, "--import", "tsx", entrypoint, "gateway"],
              },
            }),
        });
        expect(result.refuse).toBe(refuse);
      });
    },
  );

  it.each([
    { rootOptions: [] },
    { rootOptions: ["--profile", "dev"] },
    { rootOptions: ["--profile=dev"] },
    { rootOptions: ["--dev"] },
  ])(
    "refuses when the serving entrypoint is this checkout's dist with root options $rootOptions",
    async ({ rootOptions }) => {
      await withTestDir({ prefix: "openclaw-live-dist-physical-" }, async (tmp) => {
        await writeOpenClawPackage(tmp);
        const result = await inspectFixtureGateway(tmp, {
          readState: async () =>
            baseState({
              running: true,
              command: {
                programArguments: [
                  process.execPath,
                  path.join(tmp, "dist", "index.js"),
                  ...rootOptions,
                  "gateway",
                ],
              },
            }),
        });
        expect(result.refuse).toBe(true);
      });
    },
  );

  it("allows a logically owned current/releases tree whose dist is physically separate", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-release-" }, async (tmp) => {
      const managedRoot = path.join(tmp, "openclaw");
      const release = path.join(tmp, "releases", "selected");
      const current = path.join(tmp, "current");
      await writeOpenClawPackage(managedRoot);
      await writeOpenClawPackage(release);
      await fs.symlink(release, current);
      const command = {
        programArguments: [process.execPath, path.join(current, "dist", "index.js"), "gateway"],
        managedDefinition: {
          programArguments: [
            process.execPath,
            path.join(managedRoot, "dist", "index.js"),
            "gateway",
          ],
        },
      };
      const result = await inspectFixtureGateway(managedRoot, {
        readState: async () => baseState({ running: true, command }),
      });
      expect(result).toEqual({ refuse: false });
    });
  });

  it("refuses when the checkout is the physical release behind current", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-release-self-" }, async (tmp) => {
      const release = path.join(tmp, "releases", "selected");
      const current = path.join(tmp, "current");
      await writeOpenClawPackage(release);
      await fs.symlink(release, current);
      const result = await inspectFixtureGateway(release, {
        readState: async () =>
          baseState({
            running: true,
            command: {
              programArguments: [
                process.execPath,
                path.join(current, "dist", "index.js"),
                "gateway",
              ],
            },
          }),
      });
      expect(result.refuse).toBe(true);
    });
  });
});

describe("live-gateway-dist-fence cross-profile overlap", () => {
  it("refuses when another profile's live Gateway overlaps this checkout", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-cross-profile-" }, async (tmp) => {
      const otherCheckout = path.join(tmp, "other");
      await writeOpenClawPackage(tmp);
      await writeOpenClawPackage(otherCheckout);
      const defaultBinding = {
        profile: "default",
        env: { OPENCLAW_PROFILE: undefined },
      };
      const fenceproofBinding = {
        profile: "fenceproof",
        env: {
          OPENCLAW_PROFILE: "fenceproof",
          OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-fenceproof.service",
        },
      };
      const result = await inspectFixtureGateway(tmp, {
        env: {},
        listBindings: async () => [defaultBinding, fenceproofBinding],
        readState: async (binding) => {
          if (binding?.profile === "fenceproof") {
            return baseState({
              running: true,
              command: {
                programArguments: [process.execPath, path.join(tmp, "dist", "index.js"), "gateway"],
              },
              runtime: {
                status: "running",
                pid: 4242,
                systemd: { unit: "openclaw-gateway-fenceproof.service" },
              },
            });
          }
          return baseState({
            running: false,
            command: {
              programArguments: [
                process.execPath,
                path.join(otherCheckout, "dist", "index.js"),
                "gateway",
              ],
            },
            runtime: { status: "stopped", pid: undefined },
          });
        },
      });
      expect(result.refuse).toBe(true);
      if (result.refuse) {
        expect(result.message).toContain("fenceproof");
        expect(result.message).toContain("openclaw update");
        expect(result.message).toContain("openclaw gateway stop --profile fenceproof");
        expect(result.message).not.toContain("profiles default, fenceproof");
      }
    });
  });

  it.each(["saved environment", "root argv"] as const)(
    "fences a custom Windows Task using its %s profile without mutating the service",
    async (profileSource) => {
      await withTestDir({ prefix: "openclaw-live-dist-windows-profile-" }, async (tmp) => {
        const checkout = path.join(tmp, "checkout");
        const other = path.join(tmp, "other");
        const launcher = path.join(tmp, "gateway.cmd");
        await writeOpenClawPackage(checkout);
        await writeOpenClawPackage(other);
        const scriptPath = "C:\\Services\\Recovery\\gateway.cmd";
        const task = {
          taskPath: "\\Services\\Recovery",
          state: 4,
          actions: [{ type: 0, path: scriptPath, arguments: "", workingDirectory: "" }],
        };
        await fs.writeFile(
          launcher,
          [
            "@echo off",
            'set "OPENCLAW_WINDOWS_TASK_NAME=Services\\Recovery"',
            `set "OPENCLAW_PROFILE=${profileSource === "root argv" ? "stale" : "rescue"}"`,
            'set "OPENCLAW_SERVICE_MARKER=openclaw"',
            'set "OPENCLAW_SERVICE_KIND=gateway"',
            `"${process.execPath}" "${path.join(checkout, "dist", "index.js")}" ${profileSource === "root argv" ? "--profile rescue " : ""}gateway run < NUL`,
          ].join("\r\n"),
        );
        const readFile = fs.readFile;
        const files = vi
          .spyOn(fs, "readFile")
          .mockImplementation((...args: Parameters<typeof fs.readFile>) => {
            if (args[0] === scriptPath) {
              args[0] = launcher;
            }
            return readFile(...args);
          });
        const inventory = vi.spyOn(schtasksProbe, "listScheduledTasks").mockReturnValue([task]);
        const probe = vi
          .spyOn(schtasksProbe, "probeScheduledTaskState")
          .mockImplementation((name) =>
            name.replace(/^\\+/, "") === "Services\\Recovery"
              ? { status: "found", ...task }
              : { status: "missing" },
          );
        const native = vi.spyOn(schtasksExec, "execSchtasks").mockImplementation(async (args) => {
          if (args[0] !== "/Query") {
            throw new Error("Unexpected Scheduled Task mutation");
          }
          return { stdout: "", stderr: "", code: 0 };
        });
        const writes = vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("Unexpected write"));
        const renames = vi.spyOn(fs, "rename").mockRejectedValue(new Error("Unexpected rename"));
        const removals = vi.spyOn(fs, "rm").mockRejectedValue(new Error("Unexpected removal"));
        const signals = vi.spyOn(process, "kill").mockReturnValue(true);
        try {
          await withMockedPlatform("win32", async () => {
            const env = { HOME: tmp, USERPROFILE: tmp, OPENCLAW_PROFILE: "selected" };
            const result = await resolveLiveManagedGatewayDistFence(checkout, { env });
            expect(result).toMatchObject({
              refuse: true,
              message: expect.stringContaining("profile rescue"),
            });
            const bindings = await gatewayBindings.discoverManagedGatewayBindings(env);
            expect(bindings).toEqual([
              expect.objectContaining({
                profile: "rescue",
                env: expect.objectContaining({
                  OPENCLAW_PROFILE: "rescue",
                  OPENCLAW_WINDOWS_TASK_NAME: "Services\\Recovery",
                }),
              }),
            ]);
            const binding = bindings[0]!;
            await expect(
              gatewayService.readGatewayServiceState(gatewayService.resolveGatewayService(), {
                env: binding.env,
                requireEffective: true,
                requireLoadedCommand: true,
              }),
            ).resolves.toMatchObject({ installed: true, running: true });
            await expect(resolveLiveManagedGatewayDistFence(other, { env })).resolves.toEqual({
              refuse: false,
            });
            task.state = 3;
            await expect(resolveLiveManagedGatewayDistFence(checkout, { env })).resolves.toEqual({
              refuse: false,
            });
            expect(probe).toHaveBeenCalled();
            expect(native).not.toHaveBeenCalled();
            for (const mutation of [writes, renames, removals, signals]) {
              expect(mutation).not.toHaveBeenCalled();
            }
          });
        } finally {
          for (const mock of [
            signals,
            removals,
            renames,
            writes,
            native,
            probe,
            inventory,
            files,
          ]) {
            mock.mockRestore();
          }
        }
      });
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["literal", "Environment=OPENCLAW_PROFILE=fenceproof", "custom-rescue.service"],
    ["spaced", "Environment = OPENCLAW_PROFILE=fenceproof", "custom-rescue.service"],
    [
      "last assignment",
      "Environment=OPENCLAW_PROFILE=stale\nEnvironment=OPENCLAW_PROFILE=fenceproof",
      "custom-rescue.service",
    ],
    [
      "spaced reset",
      "Environment=OPENCLAW_PROFILE=stale\nEnvironment =\nEnvironment=OPENCLAW_SERVICE_MARKER=openclaw\nEnvironment=OPENCLAW_SERVICE_KIND=gateway",
      "openclaw-gateway-fenceproof.service",
    ],
    [
      "section and case",
      "Environment=OPENCLAW_PROFILE=fenceproof\n[Unit]\nEnvironment=OPENCLAW_PROFILE=wrong-section\n[Service]\nenvironment=OPENCLAW_PROFILE=wrong-case",
      "custom-rescue.service",
    ],
  ] as const)(
    "refuses through modeled Linux real-FS sibling bindings with %s inline profile metadata",
    async (_name, metadata, siblingUnit) =>
      withMockedPlatform("linux", async () => {
        await withTestDir({ prefix: "openclaw-live-dist-unit-fixture-" }, async (tmp) => {
          const home = path.join(tmp, "home");
          const checkout = path.join(tmp, "checkout");
          const other = path.join(tmp, "other");
          const systemdDir = path.join(home, ".config", "systemd", "user");
          isolateSystemdInventory(home);
          await writeOpenClawPackage(checkout);
          await writeOpenClawPackage(other);
          await fs.mkdir(systemdDir, { recursive: true });
          const unitBody = [
            "[Service]",
            "ExecStart=/usr/bin/node /srv/worker/dist/index.js gateway",
            "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
            "Environment=OPENCLAW_SERVICE_KIND=gateway",
            "",
          ].join("\n");
          await fs.writeFile(path.join(systemdDir, "openclaw-gateway.service"), unitBody);
          await fs.writeFile(path.join(systemdDir, siblingUnit), `${unitBody}${metadata}\n`);

          const { discoverManagedGatewayBindings } =
            await import("../../src/daemon/managed-gateway-bindings.ts");
          const hostConnection = {
            XDG_RUNTIME_DIR: path.join(tmp, "caller-runtime"),
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(tmp, "caller-bus")}`,
            USER: "fixture-caller",
            LOGNAME: "fixture-caller",
            SUDO_USER: "fixture-origin",
          };
          const callerEnv = { HOME: home, ...hostConnection, OPENCLAW_PROFILE: "selected" };
          const bindings = await discoverManagedGatewayBindings(callerEnv);
          expect(bindings.map((binding) => binding.profile).toSorted()).toEqual([
            "default",
            "fenceproof",
          ]);
          expect(bindings.every((binding) => binding.scope === "user")).toBe(true);
          for (const binding of bindings) {
            expect(binding.env).toMatchObject(hostConnection);
            expect(binding.env.OPENCLAW_PROFILE).not.toBe("selected");
          }

          const result = await inspectFixtureGateway(checkout, {
            env: callerEnv,
            listBindings: async () => bindings,
            readState: async (binding) => {
              if (binding?.profile === "fenceproof") {
                return baseState({
                  running: true,
                  command: {
                    programArguments: [
                      process.execPath,
                      path.join(checkout, "dist", "index.js"),
                      "gateway",
                    ],
                  },
                  runtime: {
                    status: "running",
                    pid: 77,
                    systemd: { unit: siblingUnit },
                  },
                });
              }
              return baseState({
                running: true,
                command: {
                  programArguments: [
                    process.execPath,
                    path.join(other, "dist", "index.js"),
                    "gateway",
                  ],
                },
                runtime: {
                  status: "running",
                  pid: 76,
                  systemd: { unit: "openclaw-gateway.service" },
                },
              });
            },
          });
          expect(result.refuse).toBe(true);
          if (result.refuse) {
            expect(result.message).toContain("fenceproof");
            expect(result.message).toContain("openclaw update");
            expect(result.message).not.toContain("profiles default, fenceproof");
          }
        });
      }),
  );

  it("names every overlapping live profile in the refusal", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-two-profiles-" }, async (tmp) => {
      await writeOpenClawPackage(tmp);
      const result = await inspectFixtureGateway(tmp, {
        listBindings: async () => [
          { profile: "work", env: { OPENCLAW_PROFILE: "work" } },
          { profile: "fenceproof", env: { OPENCLAW_PROFILE: "fenceproof" } },
        ],
        readState: async (binding) =>
          binding.profile === "default"
            ? baseState({ command: null })
            : baseState({
                running: true,
                command: {
                  programArguments: [
                    process.execPath,
                    path.join(tmp, "dist", "index.js"),
                    "gateway",
                  ],
                },
                runtime: {
                  status: "running",
                  pid: 99,
                  systemd: { unit: `openclaw-gateway-${binding?.profile}.service` },
                },
              }),
      });
      expect(result.refuse).toBe(true);
      if (result.refuse) {
        expect(result.message).toContain("fenceproof");
        expect(result.message).toContain("work");
        expect(result.message).toContain("openclaw update");
        expect(result.message).toContain("openclaw gateway stop --profile fenceproof");
        expect(result.message).toContain("openclaw gateway stop --profile work");
      }
    });
  });

  it("refuses when only a system-scope sibling overlaps this checkout", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-system-scope-" }, async (tmp) => {
      await writeOpenClawPackage(tmp);
      const userBinding = {
        profile: "default",
        scope: "user" as const,
        systemdReadTarget: {
          scope: "user" as const,
          unitName: "openclaw-gateway.service",
          unitPath: path.join(tmp, "user", "openclaw-gateway.service"),
        },
        env: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      };
      const systemBinding = {
        profile: "default",
        scope: "system" as const,
        systemdReadTarget: {
          scope: "system" as const,
          unitName: "openclaw-gateway.service",
          unitPath: path.join(tmp, "system", "openclaw-gateway.service"),
        },
        env: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      };
      const result = await inspectFixtureGateway(tmp, {
        listBindings: async () => [userBinding, systemBinding],
        readState: async (binding) => {
          if (binding?.scope === "system") {
            return baseState({
              running: true,
              command: {
                programArguments: [process.execPath, path.join(tmp, "dist", "index.js"), "gateway"],
              },
              runtime: {
                status: "running",
                pid: 88,
                systemd: { unit: "openclaw-gateway.service" },
              },
            });
          }
          return baseState({
            running: false,
            command: {
              programArguments: [
                process.execPath,
                path.join(tmp, "other", "dist", "index.js"),
                "gateway",
              ],
            },
            runtime: { status: "stopped", pid: undefined },
          });
        },
      });
      expect(result.refuse).toBe(true);
    });
  });

  it.skipIf(process.platform !== "linux")(
    "refuses a live system template instance while a separate user Gateway is installed",
    async () => {
      await withTestDir({ prefix: "openclaw-live-dist-template-instance-" }, async (tmp) => {
        const home = path.join(tmp, "home");
        const checkout = path.join(tmp, "checkout");
        const other = path.join(tmp, "other");
        const userDir = path.join(home, ".config", "systemd", "user");
        const systemDir = "/etc/systemd/system";
        const fixturePath = isolateSystemdInventory(home);
        await writeOpenClawPackage(checkout);
        await writeOpenClawPackage(other);
        await fs.mkdir(userDir, { recursive: true });
        await fs.mkdir(fixturePath(systemDir), { recursive: true });
        const unitBody = [
          "[Service]",
          "ExecStart=/usr/bin/node /srv/openclaw/dist/index.js gateway",
          "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
          "Environment=OPENCLAW_SERVICE_KIND=gateway",
          "",
        ].join("\n");
        await fs.writeFile(path.join(userDir, "openclaw-gateway.service"), unitBody);
        await fs.writeFile(fixturePath(path.join(systemDir, "openclaw@.service")), unitBody);
        const instanceName = `openclaw@${os.userInfo().username}.service`;

        const { discoverManagedGatewayBindings } =
          await import("../../src/daemon/managed-gateway-bindings.ts");
        const bindings = await discoverManagedGatewayBindings({ HOME: home });
        expect(bindings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              scope: "user",
              systemdReadTarget: expect.objectContaining({
                unitName: "openclaw-gateway.service",
              }),
            }),
            expect.objectContaining({
              scope: "system",
              systemdReadTarget: expect.objectContaining({
                unitName: instanceName,
                unitPath: path.join(systemDir, "openclaw@.service"),
              }),
            }),
          ]),
        );

        const result = await inspectFixtureGateway(checkout, {
          env: { HOME: home },
          listBindings: async () => bindings,
          readState: async (binding) => {
            const unitName = binding?.systemdReadTarget?.unitName ?? "";
            expect(unitName.endsWith("@.service")).toBe(false);
            if (binding?.scope === "system") {
              expect(unitName).toBe(instanceName);
              return baseState({
                running: true,
                command: {
                  programArguments: [
                    process.execPath,
                    path.join(checkout, "dist", "index.js"),
                    "gateway",
                  ],
                },
                runtime: { status: "running", pid: 91, systemd: { unit: instanceName } },
              });
            }
            return baseState({
              running: true,
              command: {
                programArguments: [
                  process.execPath,
                  path.join(other, "dist", "index.js"),
                  "gateway",
                ],
              },
              runtime: {
                status: "running",
                pid: 90,
                systemd: { unit: "openclaw-gateway.service" },
              },
            });
          },
        });
        expect(result.refuse).toBe(true);
        if (result.refuse) {
          expect(result.message).toContain(instanceName);
          expect(result.message).toContain("openclaw update");
        }
      });
    },
  );
});
