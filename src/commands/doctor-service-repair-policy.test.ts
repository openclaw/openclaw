import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  scope?: "system" | "missing" | "failed";
  unavailableManager?: boolean;
  platform?: "darwin";
};

const unit = (scope: "user" | "system" = "user") => ({
  scope,
  unitName: "openclaw-gateway.service",
  unitPath: "/fixture/openclaw-gateway.service",
});

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope: mocks.findInstalledSystemdGatewayScope,
}));

beforeEach(() => {
  mocks.findInstalledSystemdGatewayScope.mockReset();
  mocks.isContainerEnvironment.mockReset().mockReturnValue(false);
  mocks.isLoaded.mockReset().mockResolvedValue(false);
  mocks.resolveGatewayService.mockReset().mockReturnValue({
    isLoaded: mocks.isLoaded,
  });
  mockProcessPlatform("linux");
});

afterEach(() => vi.restoreAllMocks());

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
  ["Docker without a service", false, "scope", { container: true, scope: "missing" }],
  ["Docker with an unloaded user service", true, "manager", { container: true }],
  ["Docker with a system service", false, "scope", { container: true, scope: "system" }],
  ["Docker without a manager", false, "manager", { container: true, unavailableManager: true }],
  ["Docker with failed discovery", false, "scope", { container: true, scope: "failed" }],
  ["non-Linux container", false, "none", { container: true, platform: "darwin" }],
])("applies native service ownership in %s", async (_name, expected, probes, scenario) => {
  const env = scenario.env ?? {};
  mocks.isContainerEnvironment.mockReturnValue(scenario.container === true);
  if (scenario.platform) {
    mockProcessPlatform(scenario.platform);
  }
  if (scenario.scope === "failed") {
    mocks.findInstalledSystemdGatewayScope.mockRejectedValue(new Error("service discovery failed"));
  } else {
    mocks.findInstalledSystemdGatewayScope.mockResolvedValue(
      scenario.scope === "missing" ? null : unit(scenario.scope),
    );
  }
  if (scenario.unavailableManager) {
    mocks.isLoaded.mockRejectedValue(new Error("systemd user manager unavailable"));
  }

  await expect(shouldManageGatewayService(env)).resolves.toBe(expected);

  expect([
    mocks.findInstalledSystemdGatewayScope.mock.calls,
    mocks.resolveGatewayService.mock.calls,
    mocks.isLoaded.mock.calls,
  ]).toEqual([
    probes === "none" ? [] : [[env]],
    probes === "manager" ? [[]] : [],
    probes === "manager" ? [[{ env, timeoutMs: 5_000 }]] : [],
  ]);
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
