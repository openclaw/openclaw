import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  confirmDoctorServiceRepair,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";

const mocks = vi.hoisted(() => ({
  findInstalledSystemdGatewayScope:
    vi.fn<(typeof import("../daemon/systemd.js"))["findInstalledSystemdGatewayScope"]>(),
  isContainerEnvironment: vi.fn(() => false),
  isLoaded: vi.fn(async () => false),
  resolveGatewayService: vi.fn(),
}));

type Scenario = {
  env?: NodeJS.ProcessEnv;
  container?: boolean;
  scope?: "system";
  installed?: boolean;
  failedScope?: boolean;
  unavailableManager?: boolean;
  platform?: "darwin";
};

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope: mocks.findInstalledSystemdGatewayScope,
}));

describe("doctor gateway service repair policy", () => {
  beforeEach(() => {
    mocks.findInstalledSystemdGatewayScope.mockReset().mockResolvedValue({
      scope: "user",
      unitName: "openclaw-gateway.service",
      unitPath: "/home/alice/.config/systemd/user/openclaw-gateway.service",
    });
    mocks.isContainerEnvironment.mockReset().mockReturnValue(false);
    mocks.isLoaded.mockReset().mockResolvedValue(false);
    mocks.resolveGatewayService.mockReset().mockReturnValue({
      isLoaded: mocks.isLoaded,
    });
    mockProcessPlatform("linux");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<[string, boolean, "none" | "scope" | "manager", Scenario]>([
    ["native host", true, "none", {}],
    [
      "Doctor-only external policy",
      true,
      "none",
      { env: { OPENCLAW_SERVICE_REPAIR_POLICY: "external" } },
    ],
    [
      "external supervision",
      false,
      "none",
      { container: true, env: { OPENCLAW_SUPERVISOR_MODE: "external" } },
    ],
    [
      "Kubernetes",
      false,
      "none",
      {
        container: true,
        env: { KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" },
      },
    ],
    ["Docker without a service", false, "scope", { container: true, installed: false }],
    ["Docker with an unloaded user service", true, "manager", { container: true }],
    ["Docker with a system service", false, "scope", { container: true, scope: "system" }],
    ["Docker without a manager", false, "manager", { container: true, unavailableManager: true }],
    ["Docker with failed discovery", false, "scope", { container: true, failedScope: true }],
    ["non-Linux container", false, "none", { container: true, platform: "darwin" }],
  ])("applies native service ownership in %s", async (_name, expected, probes, scenario) => {
    const env = scenario.env ?? {};
    mocks.isContainerEnvironment.mockReturnValue(scenario.container === true);
    if (scenario.platform) {
      mockProcessPlatform(scenario.platform);
    }
    if (scenario.scope === "system") {
      mocks.findInstalledSystemdGatewayScope.mockResolvedValue({
        scope: "system",
        unitName: "openclaw-gateway.service",
        unitPath: "/etc/systemd/system/openclaw-gateway.service",
      });
    }
    if (scenario.installed === false) {
      mocks.findInstalledSystemdGatewayScope.mockResolvedValue(null);
    }
    if (scenario.failedScope) {
      mocks.findInstalledSystemdGatewayScope.mockRejectedValue(
        new Error("service discovery failed"),
      );
    }
    if (scenario.unavailableManager) {
      mocks.isLoaded.mockRejectedValue(new Error("systemd user manager unavailable"));
    }

    await expect(shouldManageGatewayService(env)).resolves.toBe(expected);

    if (probes === "none") {
      expect(mocks.findInstalledSystemdGatewayScope).not.toHaveBeenCalled();
    } else {
      expect(mocks.findInstalledSystemdGatewayScope).toHaveBeenCalledWith(env);
    }
    if (probes === "manager") {
      expect(mocks.resolveGatewayService).toHaveBeenCalledOnce();
      expect(mocks.isLoaded).toHaveBeenCalledWith({ env, timeoutMs: 5_000 });
    } else {
      expect(mocks.resolveGatewayService).not.toHaveBeenCalled();
      expect(mocks.isLoaded).not.toHaveBeenCalled();
    }
  });

  it.each([
    { envKey: "OPENCLAW_SERVICE_REPAIR_POLICY", value: "external" },
    { envKey: "OPENCLAW_SUPERVISOR_MODE", value: "external" },
    { envKey: "OPENCLAW_UPDATE_IN_PROGRESS", value: "1" },
  ])("never confirms a Doctor repair deferred by $envKey", async ({ envKey, value }) => {
    const prompter = createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { repair: true },
    });
    const confirm = vi.spyOn(prompter, "confirmRuntimeRepair");

    await withEnvAsync({ [envKey]: value }, async () => {
      await expect(
        confirmDoctorServiceRepair(prompter, { message: "Repair gateway service?" }),
      ).resolves.toBe(false);
    });

    expect(confirm).not.toHaveBeenCalled();
  });
});
