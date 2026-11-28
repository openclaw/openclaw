import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateCommand } from "../cli/update-cli/update-command.js";
import { SystemdServiceAccountRefusalError } from "../daemon/service-inspection-error.js";
import { defaultRuntime } from "../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const native = vi.hoisted(() => ({
  scope: vi.fn(),
  command: vi.fn(),
  capture: vi.fn(),
  restart: vi.fn(),
  active: vi.fn(),
  install: vi.fn(),
  root: "",
  ready: vi.fn(),
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
vi.mock("../daemon/systemd-service-identity.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-service-identity.js")>()),
  captureSystemdServiceIdentity: native.capture,
}));
vi.mock("../daemon/systemd-lifecycle.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-lifecycle.js")>()),
  restartSystemdService: native.restart,
}));
vi.mock("../daemon/systemd-exec.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-exec.js")>()),
  execSystemctl: native.active,
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
  }),
}));
vi.mock("../cli/daemon-cli/restart-health-probe.js", async (original) => ({
  ...(await original<typeof import("../cli/daemon-cli/restart-health-probe.js")>()),
  waitForGatewayHttpReadiness: native.ready,
}));

let home: TempHomeEnv;
let callerState: string;
let serviceState: string;
const unit = {
  scope: "system",
  unitName: "openclaw-gateway.service",
  unitPath: "/etc/systemd/system/openclaw-gateway.service",
};
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
  native.scope.mockResolvedValue(unit);
  native.command.mockRejectedValue(
    new SystemdServiceAccountRefusalError({
      ...unit,
      serviceUser: "openclaw",
      programArguments: [
        process.execPath,
        path.join(native.root, "dist", "index.js"),
        "gateway",
        "--port",
        "18789",
      ],
      workingDirectory: "/",
      selectors: { HOME: "/var/lib/openclaw", OPENCLAW_STATE_DIR: serviceState },
      selectorsIncomplete: false,
    }),
  );
  native.capture.mockResolvedValue({ ...unit, serviceUser: "openclaw" });
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
  native.restart.mockResolvedValue({ outcome: "completed" });
  native.active.mockResolvedValue({ code: 0, stdout: "active", stderr: "" });
  native.ready.mockResolvedValue({ healthz: 200, readyz: 200 });
  process.exitCode = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await home.restore();
});

it.each([false, true])(
  "sudo updates a User= unit without state writes (explicit service state=%s)",
  async (explicitState) => {
    if (explicitState) {
      vi.stubEnv("OPENCLAW_STATE_DIR", serviceState);
    }
    await updateCommand({ yes: true, json: true });
    expect(
      JSON.parse(await fs.readFile(path.join(native.root, "package.json"), "utf8")).version,
    ).toBe("2026.11.29");
    expect(native.restart).toHaveBeenCalledOnce();
    expect(native.ready).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
    expect(await fs.readdir(serviceState)).toEqual(["openclaw.json"]);
    expect(await fs.readFile(path.join(serviceState, "openclaw.json"), "utf8")).toBe(
      "not valid JSON; root must not read it",
    );
    expect(await fs.stat(callerState).catch(() => null)).toBeNull();
  },
);

it.each(["inactive", "not-ready"])(
  "does not report a %s boot as a successful update",
  async (failure) => {
    if (failure === "inactive") {
      native.active.mockResolvedValue({ code: 3, stdout: "inactive", stderr: "" });
    } else {
      native.ready.mockResolvedValue({ healthz: 200, readyz: 503 });
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
  expect(native.ready).not.toHaveBeenCalled();
  expect(defaultRuntime.log).toHaveBeenCalledWith(
    expect.stringContaining("Restart with: systemctl restart openclaw-gateway.service"),
  );
});
