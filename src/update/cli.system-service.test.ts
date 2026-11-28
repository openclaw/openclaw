import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateCommand } from "../cli/update-cli/update-command.js";
import { SystemdServiceAccountRefusalError } from "../daemon/service-inspection-error.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const native = vi.hoisted(() => ({
  scope: vi.fn(),
  command: vi.fn(),
  probe: vi.fn(),
  restart: vi.fn(),
  active: vi.fn(),
  install: vi.fn(),
  lookup: vi.fn(),
  root: "",
  engine: ">=24.0.0",
}));
// Native service inspection and package replacement have independent owner tests.
// Exercise the real CLI branch; the forbidden state boundary throws on the base.
vi.mock("../infra/postgres-sync/pool.js", async (original) => ({
  ...(await original<typeof import("../infra/postgres-sync/pool.js")>()),
  preparePostgresPoolForUpdate: async () => {
    throw new Error("root reached state setup");
  },
}));
vi.mock("../infra/openclaw-root.js", async (original) => ({
  ...(await original<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => native.root,
}));
vi.mock("../daemon/systemd-scope.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-scope.js")>()),
  findInstalledSystemdGatewayScope: native.scope,
}));
vi.mock("../daemon/systemd-service-files.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-service-files.js")>()),
  readSystemdServiceExecStart: native.command,
}));
vi.mock("../daemon/systemd-service-account-command.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-service-account-command.js")>()),
  findRootOwnedRunuser: async () => "/usr/sbin/runuser",
}));
vi.mock("../daemon/exec-file.js", async (original) => {
  const actual = await original<typeof import("../daemon/exec-file.js")>();
  return {
    ...actual,
    execFileUtf8: (...args: Parameters<typeof actual.execFileUtf8>) =>
      args[0] === "/usr/bin/getent" ? native.lookup(...args) : actual.execFileUtf8(...args),
  };
});
vi.mock("../process/exec.js", async (original) => {
  const actual = await original<typeof import("../process/exec.js")>();
  return {
    ...actual,
    runCommandWithTimeout: (...args: Parameters<typeof actual.runCommandWithTimeout>) =>
      args[0][0] === "/usr/sbin/runuser"
        ? native.probe(...args)
        : actual.runCommandWithTimeout(...args),
  };
});
vi.mock("../daemon/systemd-exec.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-exec.js")>()),
  execSystemctl: async (args: string[]) =>
    args.includes("restart") ? native.restart() : native.active(),
}));
vi.mock("../infra/package-update-steps.js", async (original) => ({
  ...(await original<typeof import("../infra/package-update-steps.js")>()),
  runGlobalPackageUpdateSteps: native.install,
}));
vi.mock("../infra/update-global.js", async (original) => ({
  ...(await original<typeof import("../infra/update-global.js")>()),
  detectGlobalInstallManagerForRoot: async () => "npm",
  resolveGlobalInstallTarget: async () => ({
    manager: "npm",
    command: "npm",
    packageRoot: native.root,
  }),
}));
vi.mock("./target.js", async (original) => ({
  ...(await original<typeof import("./target.js")>()),
  resolveTarget: async () => ({
    kind: "package",
    spec: "openclaw@2026.11.29",
    version: "2026.11.29",
    engines: { node: native.engine },
  }),
}));

let home: TempHomeEnv;
let callerState: string;
let serviceState: string;
const serviceNode = "/usr/bin/node";
const unit = {
  scope: "system",
  unitName: "openclaw-gateway.service",
  unitPath: "/etc/systemd/system/openclaw-gateway.service",
};

function serviceAccountMismatch(account = "openclaw") {
  return new SystemdServiceAccountRefusalError({
    ...unit,
    serviceUser: account,
    programArguments: [serviceNode, path.join(native.root, "dist", "index.js"), "gateway"],
    workingDirectory: "/",
    selectors: { HOME: "/var/lib/openclaw", OPENCLAW_STATE_DIR: serviceState },
    selectorsIncomplete: false,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  home = await createTempHomeEnv("root-package-only-");
  callerState = path.join(home.home, ".openclaw");
  await fs.rmdir(callerState);
  serviceState = path.join(home.home, "service-state");
  native.root = path.join(home.home, "prefix", "lib", "node_modules", "openclaw");
  await fs.mkdir(path.join(native.root, "dist"), { recursive: true });
  await fs.writeFile(path.join(native.root, "dist", "index.js"), "");
  await fs.writeFile(
    path.join(native.root, "package.json"),
    '{"name":"openclaw","version":"2026.11.28"}',
  );
  await fs.mkdir(serviceState);
  await fs.writeFile(
    path.join(serviceState, "openclaw.json"),
    "not valid JSON; root must not read it",
  );
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  mockProcessPlatform("linux");
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  native.lookup.mockResolvedValue({
    code: 0,
    termination: "exit",
    stdout: "openclaw:x:1001:1001::/var/lib/openclaw:/bin/sh\n",
    stderr: "",
  });
  native.scope.mockResolvedValue(unit);
  native.command.mockRejectedValue(serviceAccountMismatch());
  native.engine = ">=24.0.0";
  native.probe.mockResolvedValue({ code: 0, stdout: "v24.22.1\n", stderr: "" });
  native.install.mockImplementation(async () => {
    await fs.writeFile(
      path.join(native.root, "package.json"),
      '{"name":"openclaw","version":"2026.11.29"}',
    );
    return {
      steps: [],
      failedStep: null,
      afterVersion: "2026.11.29",
      recovery: { serviceRestartSafe: true },
    };
  });
  native.restart.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  native.active.mockResolvedValue({ code: 0, stdout: "active", stderr: "" });
  process.exitCode = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await home.restore();
});

it.each([
  [false, "openclaw"],
  [true, "openclaw"],
  [false, "1001"],
] as const)(
  "sudo updates a User= unit without state writes (explicit service state=%s, account=%s)",
  async (explicitState, account) => {
    native.command.mockRejectedValue(serviceAccountMismatch(account));
    if (explicitState) {
      vi.stubEnv("OPENCLAW_STATE_DIR", serviceState);
    }
    await updateCommand({ yes: true, json: true });
    expect(
      JSON.parse(await fs.readFile(path.join(native.root, "package.json"), "utf8")).version,
    ).toBe("2026.11.29");
    expect(native.restart).toHaveBeenCalledOnce();
    expect(native.probe).toHaveBeenCalledWith(
      ["/usr/sbin/runuser", "-u", "openclaw", "--", serviceNode, "--version"],
      expect.objectContaining({
        baseEnv: {},
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
        cwd: "/",
      }),
    );
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("readiness not verified") }),
    );
    expect(process.exitCode).toBe(0);
    expect(await fs.readdir(serviceState)).toEqual(["openclaw.json"]);
    expect(await fs.readFile(path.join(serviceState, "openclaw.json"), "utf8")).toBe(
      "not valid JSON; root must not read it",
    );
    expect(await fs.stat(callerState).catch(() => null)).toBeNull();
  },
);

it.each(["inactive", "restart-failed"])(
  "does not report a %s boot as a successful update",
  async (failure) => {
    if (failure === "inactive") {
      native.active.mockResolvedValue({ code: 3, stdout: "inactive", stderr: "" });
    } else {
      native.restart.mockRejectedValue(new Error("systemctl restart failed"));
    }
    await expect(updateCommand({ yes: true })).rejects.toThrow(
      "journalctl -u openclaw-gateway.service",
    );
  },
);

it("honors --no-restart without claiming the package is serving", async () => {
  await updateCommand({ yes: true, restart: false });
  expect(native.install).toHaveBeenCalledOnce();
  expect(native.restart).not.toHaveBeenCalled();
  expect(defaultRuntime.log).toHaveBeenCalledWith(
    expect.stringContaining("Restart with: systemctl restart openclaw-gateway.service"),
  );
});

it("keeps the installed package when the service runtime cannot run the target", async () => {
  native.engine = ">=26.0.0";
  await expect(updateCommand({ yes: true })).rejects.toThrow("Select a compatible runtime");
  expect(native.install).not.toHaveBeenCalled();
  expect(native.restart).not.toHaveBeenCalled();
  expect(
    JSON.parse(await fs.readFile(path.join(native.root, "package.json"), "utf8")).version,
  ).toBe("2026.11.28");
});

it("does not inspect activity until the blocking systemctl restart completes", async () => {
  const started = createDeferredCore();
  const completed = createDeferredCore();
  native.restart.mockImplementation(async () => {
    started.resolve();
    await completed.promise;
    return { code: 0, stdout: "", stderr: "" };
  });
  const updating = updateCommand({ yes: true });
  await started.promise;
  expect(native.active).not.toHaveBeenCalled();
  completed.resolve();
  await updating;
  expect(native.active).toHaveBeenCalledOnce();
});

it.each(["exit", "spawn"])(
  "refuses before replacement with the exact %s probe failure",
  async (failure) => {
    if (failure === "exit") {
      native.probe.mockResolvedValue({
        code: 126,
        stdout: "",
        stderr: "recorded runtime permission denied",
      });
    } else {
      native.probe.mockRejectedValue(new Error("recorded runtime permission denied"));
    }
    const updating = updateCommand({ yes: true });
    await expect(updating).rejects.toThrow("recorded runtime permission denied");
    await expect(updating).rejects.toThrow("Select a compatible runtime");
    expect(native.install).not.toHaveBeenCalled();
    expect(native.restart).not.toHaveBeenCalled();
  },
);

it("refuses before probing when a numeric UID has no matching NSS login", async () => {
  native.command.mockRejectedValue(serviceAccountMismatch("1001"));
  native.lookup.mockResolvedValue({
    code: 0,
    termination: "exit",
    stdout: "other:x:2001:2001::/var/lib/other:/bin/sh\n",
    stderr: "",
  });
  const updating = updateCommand({ yes: true });
  await expect(updating).rejects.toThrow("Cannot resolve service UID 1001 to a login name");
  await expect(updating).rejects.toThrow("Select a compatible runtime");
  expect(native.probe).not.toHaveBeenCalled();
  expect(native.install).not.toHaveBeenCalled();
});
