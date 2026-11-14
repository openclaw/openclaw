import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
const fixture = vi.hoisted(() => ({
  gateway: true,
  versions: { user: "2026.10.5", system: "2026.10.8" } as Record<string, string>,
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  readLocation: vi.fn(),
  readFile: vi.fn(),
  readFullState: vi.fn(),
  isEnabled: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ default: { readFile: fixture.readFile } }));
vi.mock("./gateway-run-argv.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-run-argv.js")>()),
  isGatewayRunInvocationArgv: () => fixture.gateway,
}));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => fixture,
  readGatewayServiceState: fixture.readFullState,
}));
vi.mock("../daemon/systemd-service-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd-service-files.js")>()),
  resolveSystemdUnitPathForName: (_env: unknown, name: string) =>
    "/home/example/.config/systemd/user/" + name + ".service",
  readSystemdServiceCommandLocation: fixture.readLocation,
}));
vi.mock("../daemon/systemd-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd-runtime.js")>()),
  readSystemdServiceRuntime: fixture.readRuntime,
  isSystemdServiceEnabled: fixture.isEnabled,
}));
vi.mock("../daemon/service-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service-layout.js")>()),
  summarizeGatewayServiceLayout: async (command: { fixtureScope: string }) => command,
  inspectGatewayServiceInstallationDrift: async (command: { fixtureScope: string } | undefined) =>
    command
      ? {
          serviceRoot: "/" + command.fixtureScope,
          serviceVersion: fixture.versions[command.fixtureScope],
        }
      : undefined,
}));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => "/cli",
}));
vi.mock("../infra/boundary-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/boundary-path.js")>()),
  resolveIdentityPathViaExistingAncestorSync: (p: string) => p,
}));
vi.mock("../infra/npm-registry-spec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/npm-registry-spec.js")>()),
  compareOpenClawReleaseVersions: (a: string, b: string) => a.localeCompare(b),
}));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  VERSION: "2026.10.8",
}));
import { inspectCliGatewayServiceInstallation } from "./run-main-service-installation.js";
const command = { fixtureScope: "system", programArguments: ["node", "/system/dist/index.js"] };
function runtime(
  scope = "system",
  unit = "openclaw-gateway.service",
  group = "/system.slice/openclaw-gateway.service",
) {
  return {
    status: "running",
    state: "active",
    subState: "running",
    pid: process.pid,
    systemd: { scope, unit, controlGroup: group },
  };
}
const older = () =>
  expect(inspectCliGatewayServiceInstallation({})).resolves.toMatchObject({ version: "2026.10.5" });
beforeEach(() => {
  vi.clearAllMocks();
  fixture.gateway = true;
  fixture.versions = { user: "2026.10.5", system: "2026.10.8" };
  fixture.readFile.mockImplementation(async (path: string) => {
    if (path !== "/proc/self/cgroup") {
      throw Object.assign(new Error("root-only EnvironmentFile"), { code: "EACCES" });
    }
    return "0::/system.slice/openclaw-gateway.service\n";
  });
  fixture.readLocation.mockResolvedValue({ kind: "command", command });
  fixture.readRuntime.mockResolvedValue(runtime());
  fixture.readFullState.mockRejectedValue(
    Object.assign(new Error("root-only EnvironmentFile"), { code: "EACCES" }),
  );
  fixture.isEnabled.mockRejectedValue(new Error("unrelated user manager unavailable"));
  fixture.readCommand.mockResolvedValue({
    fixtureScope: "user",
    programArguments: ["node", "/user/dist/index.js"],
    environment: {},
  });
});
describe.skipIf(process.platform === "win32")("worker policy own-service selection", () => {
  beforeEach(() => mockProcessPlatform("linux"));
  afterEach(() => vi.restoreAllMocks());
  it.each(["", "/gateway"])(
    "uses loaded location and native runtime for self in %s despite root-only EnvironmentFile",
    async (leaf) => {
      fixture.readFile.mockResolvedValue(`0::/system.slice/openclaw-gateway.service${leaf}\n`);
      await expect(inspectCliGatewayServiceInstallation({})).resolves.toBeUndefined();
      expect(fixture.readFullState).not.toHaveBeenCalled();
      expect(fixture.readFile).toHaveBeenCalledTimes(1);
      expect(fixture.readCommand).not.toHaveBeenCalled();
      expect(fixture.readRuntime).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          requireEffective: true,
          requireLoaded: true,
          systemdReadTarget: expect.objectContaining({
            scope: "system",
            unitName: "openclaw-gateway.service",
          }),
        }),
      );
      expect(fixture.readLocation).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ scope: "system", unitName: "openclaw-gateway.service" }),
      );
    },
  );
  it("accepts active but disabled own service without querying enablement or another manager", async () => {
    fixture.isEnabled.mockResolvedValue(false);
    await expect(inspectCliGatewayServiceInstallation({})).resolves.toBeUndefined();
    expect(fixture.isEnabled).not.toHaveBeenCalled();
    expect(fixture.readFullState).not.toHaveBeenCalled();
  });
  it("ordinary CLI retains older installed-service guard without manager probes", async () => {
    fixture.gateway = false;
    await older();
    expect(fixture.readRuntime).not.toHaveBeenCalled();
    expect(fixture.readLocation).not.toHaveBeenCalled();
    expect(fixture.readFile).not.toHaveBeenCalled();
  });
  it("retains older installed guard when no service runs", async () => {
    fixture.readRuntime.mockResolvedValue({ ...runtime(), status: "stopped", state: "inactive" });
    await older();
  });
  it.each(["", "/gateway"])(
    "does not trust a child process in the same cgroup %s",
    async (leaf) => {
      fixture.readFile.mockResolvedValue(`0::/system.slice/openclaw-gateway.service${leaf}\n`);
      fixture.readRuntime.mockResolvedValue({ ...runtime(), pid: process.pid + 1 });
      await older();
    },
  );
  it.each(["", "/gateway"])(
    "preserves protection for a genuinely older own effective package in %s",
    async (leaf) => {
      fixture.readFile.mockResolvedValue(`0::/system.slice/openclaw-gateway.service${leaf}\n`);
      fixture.versions.system = "2026.10.6";
      await expect(
        inspectCliGatewayServiceInstallation({ OPENCLAW_STATE_DIR: "/service-state" }),
      ).resolves.toMatchObject({
        root: "/system",
        version: "2026.10.6",
        databasePath: "/service-state/state/openclaw.sqlite",
      });
    },
  );
  it.each(["", "/gateway"])("uses exact custom user unit from cgroup %s", async (leaf) => {
    const group = "/user.slice/user-1000.slice/user@1000.service/app.slice/custom-gateway.service";
    fixture.readFile.mockResolvedValue("0::" + group + leaf + "\n");
    fixture.readRuntime.mockResolvedValue(runtime("user", "custom-gateway.service", group));
    await expect(inspectCliGatewayServiceInstallation({})).resolves.toBeUndefined();
    expect(fixture.readLocation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ scope: "user", unitName: "custom-gateway.service" }),
    );
  });
  it("uses systemd hierarchy on hybrid cgroups", async () => {
    const group = "/system.slice/custom-gateway.service";
    fixture.readFile.mockResolvedValue(
      "2:memory:/user.slice/user@1000.service\n1:name=systemd:" + group + "\n",
    );
    fixture.readRuntime.mockResolvedValue(runtime("system", "custom-gateway.service", group));
    await expect(inspectCliGatewayServiceInstallation({})).resolves.toBeUndefined();
  });
  it.each(["agent-exec", "other", "gateway/nested", "other/gateway"])(
    "retains the installed-service guard for an unrelated subgroup %s",
    async (leaf) => {
      fixture.readFile.mockResolvedValue(`0::/system.slice/openclaw-gateway.service/${leaf}\n`);
      await older();
    },
  );
  it("retains old facts if location inspection is denied", async () => {
    fixture.readLocation.mockRejectedValueOnce(new Error("AccessDenied"));
    await older();
  });
  it("retains old facts if runtime is uncertain", async () => {
    fixture.readRuntime.mockResolvedValue({ ...runtime(), status: "unknown" });
    await older();
  });
  it("retains old facts if native loaded command is absent", async () => {
    fixture.readLocation.mockResolvedValue({ kind: "not-loaded" });
    await older();
  });
  it.each(["scope", "unit", "controlGroup"])("rejects mismatching runtime %s", async (field) => {
    const own = runtime();
    fixture.readRuntime.mockResolvedValue({
      ...own,
      systemd: { ...own.systemd, [field]: "other" },
    });
    await older();
  });
  it("does not infer a service from terminal scope", async () => {
    fixture.readFile.mockResolvedValue("0::/user.slice/session-12.scope\n");
    await older();
    expect(fixture.readRuntime).not.toHaveBeenCalled();
  });
});

describe("worker policy installed-service fallbacks", () => {
  it("keeps no-service CLI behavior without attempting self inspection", async () => {
    fixture.gateway = false;
    fixture.readCommand.mockResolvedValue(undefined);
    await expect(inspectCliGatewayServiceInstallation({})).resolves.toBeUndefined();
    expect(fixture.readFile).not.toHaveBeenCalled();
    expect(fixture.readRuntime).not.toHaveBeenCalled();
  });
  it("keeps an aligned installed service unrestricted for ordinary CLI", async () => {
    fixture.gateway = false;
    fixture.versions.user = "2026.10.8";
    await expect(inspectCliGatewayServiceInstallation({})).resolves.toBeUndefined();
    expect(fixture.readRuntime).not.toHaveBeenCalled();
  });
  it.each(["darwin", "win32"])("preserves the installed-service guard on %s", async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!descriptor) {
      throw new Error("missing platform descriptor");
    }
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      await older();
      expect(fixture.readFile).not.toHaveBeenCalled();
      expect(fixture.readRuntime).not.toHaveBeenCalled();
      expect(fixture.readLocation).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
});
