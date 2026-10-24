import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import * as gatewayBindings from "../../src/daemon/managed-gateway-bindings.js";
import type { ManagedGatewayBinding } from "../../src/daemon/managed-gateway-bindings.js";
import * as schtasksExec from "../../src/daemon/schtasks-exec.js";
import * as schtasksProbe from "../../src/daemon/schtasks-state-probe.js";
import * as serviceLayout from "../../src/daemon/service-layout.js";
import type { GatewayServiceState } from "../../src/daemon/service-types.ts";
import * as gatewayService from "../../src/daemon/service.js";
import * as loadedUnits from "../../src/daemon/systemd-loaded-unit-inventory.js";
import * as systemdFiles from "../../src/daemon/systemd-service-files.js";
import { CommandProcessCleanupError } from "../../src/process/exec-result.js";
import { createSuiteTempRootTracker } from "../../src/test-helpers/temp-dir.js";
import { withMockedPlatform } from "../../src/test-utils/vitest-spies.js";
import { createDeferred } from "../helpers/promise.js";

const dirs = createSuiteTempRootTracker({ prefix: "openclaw-live-dist-" });
const defaultUnit = "openclaw-gateway.service";
type FenceResult = Awaited<ReturnType<typeof resolveLiveManagedGatewayDistFence>>;
let tmp: string;
beforeEach(async () => {
  tmp = await dirs.setup();
});
afterEach(dirs.cleanup);

function baseState(overrides: Partial<GatewayServiceState> = {}): GatewayServiceState {
  return {
    installed: true,
    loadState: { status: "loaded" },
    running: false,
    env: {},
    command: gatewayCommand("/srv/openclaw"),
    ...overrides,
  };
}

function restoreAfter(...mocks: { mockRestore(): unknown }[]) {
  onTestFinished(() => mocks.forEach((mock) => mock.mockRestore()));
}

function expectRefusal(result: FenceResult, ...parts: string[]) {
  expect(result.refuse).toBe(true);
  const message = result.refuse ? result.message : "";
  for (const part of parts) {
    expect(message).toContain(part);
  }
  return message;
}

function gatewayCommand(root: string, rootOptions: string[] = []) {
  return {
    programArguments: [
      process.execPath,
      path.join(root, "dist", "index.js"),
      ...rootOptions,
      "gateway",
    ],
  };
}

function runningUnit(root: string, unit: string, pid: number) {
  return stateForPackage(root, {
    running: true,
    runtime: { status: "running", pid, systemd: { unit } },
  });
}

async function inspectFixtureGateway(
  root: string,
  readState: (
    binding: ManagedGatewayBinding,
    input: Parameters<typeof gatewayService.readGatewayServiceState>[1],
  ) => Promise<GatewayServiceState>,
  fixture: {
    env?: NodeJS.ProcessEnv;
    bindings?: readonly ManagedGatewayBinding[];
  } = {},
) {
  const discover = vi
    .spyOn(gatewayBindings, "discoverManagedGatewayBindings")
    .mockImplementation(async (env, options) => [
      ...(options?.includeInvoking ? [{ env }] : []),
      ...(fixture.bindings ?? []),
    ]);
  const read = vi
    .spyOn(gatewayService, "readGatewayServiceState")
    .mockImplementation(async (_service, input = {}) => {
      const target = input.systemdReadTarget;
      return readState(
        {
          env: input.env ?? {},
          scope: target?.scope,
          systemdReadTarget: target,
          windowsStartupEntry: input.windowsStartupEntry,
        },
        input,
      );
    });
  restoreAfter(read, discover);
  // Darwin's native binding dispatch is covered in managed-gateway-bindings.test.ts.
  return withMockedPlatform(process.platform === "win32" ? "win32" : "linux", () =>
    resolveLiveManagedGatewayDistFence(root, { env: fixture.env ?? {} }),
  );
}

function stateForPackage(root: string, overrides: Partial<GatewayServiceState> = {}) {
  return baseState({ command: gatewayCommand(root), ...overrides });
}

const unitBody = [
  "[Service]",
  "ExecStart=/usr/bin/node /srv/worker/dist/index.js gateway",
  "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
  "Environment=OPENCLAW_SERVICE_KIND=gateway",
  "",
].join("\n");

async function packagePair(root: string) {
  const checkout = path.join(root, "checkout"),
    other = path.join(root, "other");
  await writeOpenClawPackage(checkout);
  await writeOpenClawPackage(other);
  return { checkout, other };
}

async function systemdFixture(sibling: string, metadata = "", hostEnv: NodeJS.ProcessEnv = {}) {
  const home = path.join(tmp, "home");
  const pair = await packagePair(tmp);
  const fixturePath = isolateSystemdInventory(home);
  const userDir = path.join(home, ".config", "systemd", "user");
  for (const [file, extra] of [
    [path.join(userDir, defaultUnit), ""],
    [sibling.startsWith("/") ? fixturePath(sibling) : path.join(userDir, sibling), metadata],
  ] as const) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, unitBody + extra + "\n");
  }
  const env = { HOME: home, ...hostEnv };
  const bindings = await gatewayBindings.discoverManagedGatewayBindings(env);
  return { ...pair, env, bindings };
}

it("retains uncertain command-location work before consulting another service reader", async () => {
  const failure = new CommandProcessCleanupError();
  const discover = vi
    .spyOn(gatewayBindings, "discoverManagedGatewayBindings")
    .mockImplementation(async (env, options) => (options?.includeInvoking ? [{ env }] : []));
  const location = vi
    .spyOn(systemdFiles, "readSystemdServiceCommandLocation")
    .mockRejectedValue(failure);
  const read = vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue(baseState());
  restoreAfter(discover, location, read);
  await expect(
    withMockedPlatform("linux", () =>
      resolveLiveManagedGatewayDistFence(tmp, { env: {}, requireVerified: true }),
    ),
  ).rejects.toBe(failure);
  expect(read).not.toHaveBeenCalled();
});
it("retains uncertain native read cleanup instead of allowing a build", async () => {
  const failure = new CommandProcessCleanupError();
  await expect(
    inspectFixtureGateway(tmp, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});
it.each([[], ["--profile", "dev"], ["--profile=dev"], ["--dev"]].map((options) => [options]))(
  "fences the loaded command and names its recovery owner with root options %j",
  async (rootOptions) => {
    const savedDefinition = path.join(tmp, "saved-definition");
    await writeOpenClawPackage(tmp);
    await writeOpenClawPackage(savedDefinition);
    const result = await inspectFixtureGateway(tmp, async (_binding, input) => ({
      ...runningUnit(tmp, defaultUnit, process.pid),
      command: gatewayCommand(
        input?.requireEffective && input.requireLoadedCommand ? tmp : savedDefinition,
        rootOptions,
      ),
    }));
    expectRefusal(result, path.join(tmp, "dist", "index.js"), defaultUnit, "openclaw update");
  },
);

it.each([
  ["stopped", { status: "stopped", state: "inactive" }, false],
  [
    "failed with remaining cgroup tasks and no MainPID",
    { status: "unknown", state: "failed", systemd: { tasksCurrent: 2 } },
    true,
  ],
  [
    "deactivating without a MainPID",
    { status: "stopped", state: "deactivating", subState: "stop-post" },
    true,
  ],
] satisfies [string, GatewayServiceState["runtime"], boolean][])(
  "classifies a %s service using its native state",
  async (_name, runtime, refuse) => {
    await writeOpenClawPackage(tmp);
    const result = await inspectFixtureGateway(tmp, async () => stateForPackage(tmp, { runtime }));
    expect(result.refuse).toBe(refuse);
  },
);

it("allows a foreign running checkout", async () => {
  const { checkout, other } = await packagePair(tmp);
  expect(
    await inspectFixtureGateway(checkout, async () => stateForPackage(other, { running: true })),
  ).toEqual({ refuse: false });
});

it.each([
  { code: "EPERM", refuse: true },
  { code: "ESRCH", refuse: false },
])("distinguishes a $code PID probe when matching dist", async ({ code, refuse }) => {
  await writeOpenClawPackage(tmp);
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(`synthetic ${code}`), { code });
  });
  restoreAfter(kill);
  const result = await inspectFixtureGateway(tmp, async () =>
    stateForPackage(tmp, {
      runtime: { status: "stopped", state: "inactive", pid: process.pid },
    }),
  );
  expect(kill).toHaveBeenCalledWith(process.pid, 0);
  expect(result.refuse).toBe(refuse);
});

it.each(["service", "layout"])("fails open when %s inspection throws", async (phase) => {
  if (phase === "layout") {
    const layout = vi
      .spyOn(serviceLayout, "summarizeGatewayServiceLayout")
      .mockRejectedValue(new Error("realpath failed"));
    restoreAfter(layout);
  }
  expect(
    await inspectFixtureGateway("/synthetic/openclaw", async () => {
      if (phase === "service") {
        throw new Error("no service manager");
      }
      return baseState({ running: true });
    }),
  ).toEqual({ refuse: false });
});

async function writeOpenClawPackage(packageRoot: string) {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"openclaw"}\n');
  await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "gateway\n");
}

function isolateSystemdInventory(home: string) {
  const loaded = vi.spyOn(loadedUnits, "listLoadedSystemdUnits").mockResolvedValue([]);
  const systemRoots = ["/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"];
  const fixturePath = (value: string) => {
    const normalized = path.normalize(value);
    return systemRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
      ? path.join(home, "native", normalized.slice(1))
      : value;
  };
  const readdir = fs.readdir;
  const directories = vi.spyOn(fs, "readdir").mockImplementation((...args) => {
    if (typeof args[0] === "string") {
      args[0] = fixturePath(args[0]);
    }
    return readdir(...args);
  });
  const files = redirectReads(fixturePath);
  restoreAfter(loaded, files, directories);
  return fixturePath;
}

function redirectReads(redirect: (file: string) => string) {
  const readFile = fs.readFile;
  return vi.spyOn(fs, "readFile").mockImplementation((...args) => {
    if (typeof args[0] === "string") {
      args[0] = redirect(args[0]);
    }
    return readFile(...args);
  });
}

it.each([
  { entry: "src/entry.ts", distPresent: true, refuse: false },
  { entry: "openclaw.mjs", distPresent: true, refuse: true },
  { entry: "openclaw.mjs", distPresent: false, refuse: false },
  { entry: "dist/index.js", distPresent: false, refuse: false },
])(
  "distinguishes dist use by a live $entry command (dist present: $distPresent)",
  async ({ entry, distPresent, refuse }) => {
    await writeOpenClawPackage(tmp);
    const entrypoint = path.join(tmp, entry);
    await fs.mkdir(path.dirname(entrypoint), { recursive: true });
    await fs.writeFile(entrypoint, "// synthetic service entrypoint\n");
    if (!distPresent) {
      await fs.rm(path.join(tmp, "dist"), { recursive: true });
    }
    const result = await inspectFixtureGateway(tmp, async () =>
      baseState({
        running: true,
        command: {
          programArguments: [process.execPath, "--import", "tsx", entrypoint, "gateway"],
        },
      }),
    );
    expect(result.refuse).toBe(refuse);
  },
);

it.each([false, true])(
  "compares the physical release behind current (same checkout: %s)",
  async (sameCheckout) => {
    const managedRoot = path.join(tmp, "openclaw");
    const release = path.join(tmp, "releases", "selected");
    const current = path.join(tmp, "current");
    await writeOpenClawPackage(managedRoot);
    await writeOpenClawPackage(release);
    await fs.symlink(release, current);
    const result = await inspectFixtureGateway(sameCheckout ? release : managedRoot, async () =>
      baseState({
        running: true,
        command: {
          ...gatewayCommand(current),
          ...(sameCheckout ? {} : { managedDefinition: gatewayCommand(managedRoot) }),
        },
      }),
    );
    if (sameCheckout) {
      expect(result.refuse).toBe(true);
    } else {
      expect(result).toEqual({ refuse: false });
    }
  },
);

it("names every overlapping live profile", async () => {
  await writeOpenClawPackage(tmp);
  const profiles = ["work", "fenceproof"];
  const result = await inspectFixtureGateway(
    tmp,
    async (binding) => {
      const profile = binding.env.OPENCLAW_PROFILE;
      return profile
        ? runningUnit(tmp, `openclaw-gateway-${profile}.service`, 4242)
        : baseState({ command: null });
    },
    {
      bindings: profiles.map((profile) => ({
        env: { OPENCLAW_PROFILE: profile },
      })),
    },
  );
  const message = expectRefusal(
    result,
    "openclaw update",
    ...profiles.flatMap((profile) => [profile, `openclaw-gateway-${profile}.service`]),
  );
  expect(message).not.toContain("profiles default, fenceproof");
});

it("fences a custom Windows Task using its root argv profile without mutating the service", async () => {
  const { checkout, other } = await packagePair(tmp);
  const launcher = path.join(tmp, "gateway.cmd");
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
      'set "OPENCLAW_PROFILE=stale"',
      'set "OPENCLAW_SERVICE_MARKER=openclaw"',
      'set "OPENCLAW_SERVICE_KIND=gateway"',
      `"${process.execPath}" "${path.join(checkout, "dist", "index.js")}" --profile rescue gateway run < NUL`,
    ].join("\r\n"),
  );
  const files = redirectReads((file) => (file === scriptPath ? launcher : file));
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
  restoreAfter(signals, removals, renames, writes, native, probe, inventory, files);
  await withMockedPlatform("win32", async () => {
    const env = { HOME: tmp, USERPROFILE: tmp, OPENCLAW_PROFILE: "selected" };
    const result = await resolveLiveManagedGatewayDistFence(checkout, { env });
    expectRefusal(result, `Scheduled Task ${JSON.stringify("Services\\Recovery")}`);
    await expect(resolveLiveManagedGatewayDistFence(other, { env })).resolves.toEqual({
      refuse: false,
    });
    task.state = 2;
    await expect(resolveLiveManagedGatewayDistFence(checkout, { env })).resolves.toEqual(result);
    task.state = 3;
    await expect(resolveLiveManagedGatewayDistFence(checkout, { env })).resolves.toEqual({
      refuse: false,
    });
    expect(probe).toHaveBeenCalled();
    for (const mutation of [native, writes, renames, removals, signals]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });
});

it.skipIf(process.platform === "win32").each([
  [
    "spaced reset",
    "Environment=OPENCLAW_PROFILE=stale\nEnvironment =\nEnvironment=OPENCLAW_SERVICE_MARKER=openclaw\nEnvironment=OPENCLAW_SERVICE_KIND=gateway",
    "openclaw-gateway-fenceproof.service",
  ],
  [
    "section and case",
    "Environment=OPENCLAW_PROFILE=stale\nEnvironment = OPENCLAW_PROFILE=fenceproof\n[Unit]\nEnvironment=OPENCLAW_PROFILE=wrong-section\n[Service]\nenvironment=OPENCLAW_PROFILE=wrong-case",
    "custom-rescue.service",
  ],
] as const)(
  "refuses through modeled Linux real-FS sibling bindings with %s inline profile metadata",
  async (_name, metadata, siblingUnit) =>
    withMockedPlatform("linux", async () => {
      const { checkout, other, env, bindings } = await systemdFixture(siblingUnit, metadata, {
        OPENCLAW_PROFILE: "selected",
      });

      const result = await inspectFixtureGateway(
        checkout,
        async (binding) =>
          binding.systemdReadTarget?.unitName === siblingUnit
            ? runningUnit(checkout, siblingUnit, 77)
            : runningUnit(other, defaultUnit, 76),
        { env, bindings },
      );
      expect(expectRefusal(result, siblingUnit, "openclaw update")).not.toContain(
        "profiles default, fenceproof",
      );
    }),
);

it("continues to a live sibling after a Startup file read exhausts its inspection budget", async () => {
  await writeOpenClawPackage(tmp);
  const startupPath = "C:\\Startup\\stalled.cmd";
  const pending = createDeferred<Awaited<ReturnType<typeof fs.readFile>>>();
  const entered = createDeferred();
  const readState = gatewayService.readGatewayServiceState;
  const readFile = fs.readFile.bind(fs);
  let signal: AbortSignal | undefined;
  const files = vi.spyOn(fs, "readFile").mockImplementation((...args) => {
    if (args[0] !== startupPath) {
      return readFile(...args);
    }
    const options = args[1];
    signal = typeof options === "object" && options !== null ? options.signal : undefined;
    entered.resolve();
    return pending.promise;
  });
  try {
    await withMockedPlatform("win32", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const inspection = inspectFixtureGateway(
        tmp,
        async (binding, input) =>
          input?.windowsStartupEntry
            ? readState(gatewayService.resolveGatewayService(), input)
            : stateForPackage(tmp, { running: binding.env.OPENCLAW_PROFILE === "live" }),
        {
          bindings: [
            { env: {}, windowsStartupEntry: startupPath },
            { env: { OPENCLAW_PROFILE: "live" } },
          ],
        },
      );
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(signal?.aborted).toBe(true);
        expectRefusal(await inspection, "Scheduled Task", "live");
      } finally {
        pending.reject(new Error("Fixture file read released"));
        try {
          await inspection;
        } finally {
          vi.useRealTimers();
        }
      }
    });
  } finally {
    files.mockRestore();
  }
});

it.each([true, false])(
  "keeps distinct Startup file bindings when only the second holds dist (running=%s)",
  async (running) => {
    await writeOpenClawPackage(tmp);
    const first = "C:\\Startup\\same-label.cmd";
    const second = "C:\\Startup\\same-label.vbs";
    const result = await inspectFixtureGateway(
      tmp,
      async (binding) =>
        stateForPackage(tmp, {
          running: running && binding.windowsStartupEntry === second,
          runtime: { status: "unknown" },
        }),
      {
        bindings: [first, second].map((windowsStartupEntry) => ({
          scope: "user",
          env: { OPENCLAW_PROFILE: "rescue" },
          windowsStartupEntry,
        })),
      },
    );
    expect(result.refuse).toBe(running);
    if (result.refuse) {
      expect(result.message).toContain(`Startup entry ${JSON.stringify(second)}`);
      expect(result.message).not.toContain("openclaw gateway stop --profile rescue");
      expect(result.message).not.toContain("openclaw update");
      expect(result.message).not.toContain("matching service stop");
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "refuses a live system template instance while a separate user Gateway is installed",
  async () => {
    const unitPath = "/etc/systemd/system/openclaw@.service";
    const { checkout, other, env, bindings } = await systemdFixture(unitPath);
    const instanceName = `openclaw@${os.userInfo().username}.service`;

    const result = await inspectFixtureGateway(
      checkout,
      async (binding) => {
        const unitName = binding?.systemdReadTarget?.unitName ?? "";
        if (binding?.scope === "system") {
          expect(unitName).toBe(instanceName);
          return runningUnit(checkout, instanceName, 91);
        }
        return runningUnit(other, defaultUnit, 90);
      },
      { env, bindings },
    );
    expectRefusal(result, instanceName, "openclaw update");
  },
);
