import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveLaunchAgentProgramArguments } from "../../daemon/launchd-plist.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import {
  createGatewayServiceRunArgs,
  lifecycleRuntimeLogs,
  lifecycleTestRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const loadConfig = vi.fn<() => OpenClawConfig>();
// mock-isolation: Each case supplies configuration without reading operator state.
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: lifecycleTestRuntime,
}));
// mock-isolation: Restart intent operations must not touch the host Gateway state.
vi.mock("../../infra/restart-intent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-intent.js")>()),
  prepareGatewayRestartIntentLegacyProcess: async () => undefined,
  clearGatewayRestartIntentSync: () => undefined,
  writeGatewayRestartIntentSync: () => undefined,
  writeGatewayServiceRestartIntentSync: () => undefined,
}));
const { runServiceRestart } = await import("./lifecycle-core.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  mockSystemAccountHome();
  stubEmptyGatewayEnv();
  vi.stubEnv("UNRESOLVED_TOKEN_KEY", "");
  resetLifecycleServiceMocks();
  resetLifecycleRuntimeLogs();
});

it.each([
  { name: "changed", value: "new-value", tokenUnavailable: false },
  { name: "removed", value: undefined, tokenUnavailable: false },
  { name: "token unavailable", value: "new-value", tokenUnavailable: true },
])("warns for managed environment drift when $name without changing restart", async (scenario) => {
  loadConfig.mockReturnValue({
    env: scenario.value ? { TAVILY_API_KEY: scenario.value } : {},
    ...(scenario.tokenUnavailable
      ? {
          secrets: { providers: { default: { source: "env" } } },
          gateway: {
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "UNRESOLVED_TOKEN_KEY" },
            },
          },
        }
      : {}),
  });
  const home = tempDirs.make("managed-env-drift-");
  const envFile = path.join(home, "fixture.env");
  await fs.writeFile(
    envFile,
    "export OPENCLAW_SERVICE_MANAGED_ENV_KEYS='TAVILY_API_KEY'\nexport TAVILY_API_KEY='old-value'\n",
  );
  const command = await resolveLaunchAgentProgramArguments(
    {
      ProgramArguments: ["/bin/sh", path.join(home, "fixture-env-wrapper.sh"), envFile, "node"],
    },
    path.join(home, "fixture.plist"),
  );
  expect(command.environmentValueSources?.TAVILY_API_KEY).toBe("file");
  service.readCommand.mockResolvedValue(command);
  await runServiceRestart(createGatewayServiceRunArgs(true));
  const output = lifecycleRuntimeLogs.find((line) => line.trim().startsWith("{"));
  const payload = JSON.parse(output ?? "{}") as { warnings?: string[] };
  expect(payload.warnings).toContainEqual(expect.stringContaining("managed keys (TAVILY_API_KEY)"));
  expect(payload.warnings).toContainEqual(expect.stringContaining("gateway install --force"));
  expect(JSON.stringify(payload)).not.toMatch(/old-value|new-value/);
  if (scenario.tokenUnavailable) {
    expect(payload.warnings).toContainEqual(
      expect.stringContaining("SecretRef is configured but unavailable"),
    );
  }
  expect(service.restart).toHaveBeenCalledOnce();
});
