import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  confirmDoctorServiceRepair,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";

const mocks = vi.hoisted(() => ({
  findScope: vi.fn<(typeof import("../daemon/systemd.js"))["findInstalledSystemdGatewayScope"]>(),
  isContainer: vi.fn(() => false),
  isLoaded: vi.fn(async () => false),
  service: vi.fn(),
}));

type Scenario = {
  env?: NodeJS.ProcessEnv;
  container?: boolean;
  scope?: "system" | "missing";
  unavailableManager?: boolean;
  platform?: "darwin";
};

// mock-isolation: Model container policy without reading the test host's environment or files.
vi.mock("../infra/container-environment.js", () => ({ isContainerEnvironment: mocks.isContainer }));
// mock-isolation: Control manager readiness without invoking an installed Gateway service.
vi.mock("../daemon/service.js", () => ({ resolveGatewayService: mocks.service }));
// mock-isolation: Model unit discovery without probing systemd on the test host.
vi.mock("../daemon/systemd.js", () => ({ findInstalledSystemdGatewayScope: mocks.findScope }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isLoaded.mockResolvedValue(false);
  mocks.service.mockReturnValue({ isLoaded: mocks.isLoaded });
  mockProcessPlatform("linux");
});

afterEach(() => vi.restoreAllMocks());

const supervisor = { OPENCLAW_SUPERVISOR_MODE: "external" };
const kubernetes = { KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" };
it.each<[string, boolean, Scenario]>([
  ["native host", true, {}],
  ["external supervisor", false, { container: true, env: supervisor }],
  ["Kubernetes", false, { container: true, env: kubernetes }],
  ["missing unit", false, { container: true, scope: "missing" }],
  ["unloaded user unit", true, { container: true }],
  ["system unit", false, { container: true, scope: "system" }],
  ["unavailable manager", false, { container: true, unavailableManager: true }],
  ["non-Linux container", false, { container: true, platform: "darwin" }],
])("applies native service ownership in %s", async (_name, expected, scenario) => {
  mocks.isContainer.mockReturnValue(scenario.container === true);
  if (scenario.platform) {
    mockProcessPlatform(scenario.platform);
  }
  mocks.findScope.mockResolvedValue(
    scenario.scope === "missing"
      ? null
      : {
          scope: scenario.scope ?? "user",
          unitName: "openclaw-gateway.service",
          unitPath: "/fixture/openclaw-gateway.service",
        },
  );
  if (scenario.unavailableManager) {
    mocks.isLoaded.mockRejectedValue(new Error("systemd user manager unavailable"));
  }

  await expect(shouldManageGatewayService(scenario.env ?? {})).resolves.toBe(expected);
});

it.each([
  ["OPENCLAW_SERVICE_REPAIR_POLICY", "external"],
  ["OPENCLAW_SUPERVISOR_MODE", "external"],
  ["OPENCLAW_UPDATE_IN_PROGRESS", "1"],
])("never confirms a Doctor repair deferred by %s", async (envKey, value) => {
  const prompter = createDoctorPrompter({
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options: { repair: true },
  });
  const confirm = vi.spyOn(prompter, "confirmRuntimeRepair");

  await withEnvAsync({ [envKey]: value }, () =>
    expect(
      confirmDoctorServiceRepair(prompter, { message: "Repair gateway service?" }),
    ).resolves.toBe(false),
  );

  expect(confirm).not.toHaveBeenCalled();
});
