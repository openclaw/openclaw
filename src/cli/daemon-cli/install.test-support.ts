import { afterEach, beforeEach, vi } from "vitest";
import type * as configPaths from "../../config/paths.js";
import type { DaemonRuntimePinSnapshot } from "../../daemon/runtime-pin-types.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import type { ResolvedGatewayAuth } from "../../gateway/auth.js";
import { captureFullEnv } from "../../test-utils/env.js";
import { createInstallPlanFixture, nodeProbeOutput } from "./install.test-helpers.js";
import type { createDaemonInstallActionContext } from "./shared.js";

const mocks = vi.hoisted(() => ({
  pinSnapshot: vi.fn<() => DaemonRuntimePinSnapshot>(() => ({ revision: "empty", stored: false })),
  pinMigration: vi.fn(async () => {}),
  tls: vi.fn(),
  exec: vi.fn(),
  config: vi.fn(),
  port: vi.fn<typeof configPaths.resolveGatewayPort>(() => 18789),
  writeConfig: vi.fn(),
  auth: vi.fn<() => ResolvedGatewayAuth>(() => ({
    mode: "token",
    token: undefined,
    password: undefined,
    allowTailscale: false,
  })),
  bindHost: vi.fn(async () => "127.0.0.1"),
  secrets: vi.fn(async () => new Map()),
  token: vi.fn(() => "generated-token"),
  plan: vi.fn<
    (
      params: Parameters<
        typeof import("../../commands/daemon-install-helpers.js").buildGatewayInstallPlan
      >[0],
    ) => ReturnType<typeof createInstallPlanFixture>
  >(),
  runtime: vi.fn(() => true),
  install: vi.fn(async (_params?: unknown) => {}),
  configReady: vi.fn(async () => {}),
}));
vi.mock("../../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-pin-state.js")>()),
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, run: () => T) => {
    await mocks.pinMigration();
    return run();
  },
  readDaemonRuntimePinForInstall: mocks.pinSnapshot,
  readDaemonRuntimePin: mocks.pinSnapshot,
}));
type DaemonActionResponse = Parameters<
  ReturnType<typeof createDaemonInstallActionContext>["emit"]
>[0];
vi.mock("../program/config-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../program/config-guard.js")>()),
  ensureConfigReady: mocks.configReady,
}));
const actionState = vi.hoisted(() => ({
  warnings: [] as string[],
  emitted: [] as DaemonActionResponse[],
  failed: [] as Array<{ message: string; hints?: string[] }>,
}));
const installService = vi.hoisted(() => ({
  loadedText: "loaded",
  isLoaded: vi.fn(async () => false),
  install: vi.fn(async () => {}),
  readDefinitionMutationCapability: vi.fn(async () => ({ kind: "writable" as const })),
  readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(async () => null),
}));
vi.mock("../../bootstrap/node-startup-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../bootstrap/node-startup-env.js")>()),
  resolveNodeStartupTlsEnvironment: mocks.tls,
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: mocks.exec,
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotForWrite: vi.fn(async () => ({
    snapshot: await mocks.config(),
    writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
  })),
}));
vi.mock("../../config/mutate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/mutate.js")>()),
  replaceConfigFile: mocks.writeConfig,
}));
vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  resolveGatewayPort: mocks.port,
}));
vi.mock("../../gateway/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/auth.js")>()),
  resolveGatewayAuth: mocks.auth,
}));
vi.mock("../../gateway/net.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/net.js")>()),
  resolveGatewayBindHost: mocks.bindHost,
}));
vi.mock("../../secrets/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../secrets/resolve.js")>()),
  resolveSecretRefValues: mocks.secrets,
}));
vi.mock("../../commands/random-token.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/random-token.js")>()),
  randomToken: mocks.token,
}));
vi.mock("../../commands/daemon-install-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/daemon-install-helpers.js")>()),
  buildGatewayInstallPlan: mocks.plan,
}));
vi.mock("../../daemon/program-args.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/program-args.js")>()),
  OPENCLAW_WRAPPER_ENV_KEY: "OPENCLAW_WRAPPER",
  resolveOpenClawWrapperPath: async (value: string | undefined) => value?.trim() || undefined,
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  createDaemonInstallActionContext: (jsonFlag: unknown) => {
    const json = Boolean(jsonFlag);
    // Plan decisions only; the integration suite exercises actual CLI output.
    const emit = (payload: DaemonActionResponse) => {
      actionState.emitted.push(payload);
    };
    return {
      json,
      stdout: process.stdout,
      warnings: actionState.warnings,
      emit,
      emitMessage: emit,
      warn: (message: string) => {
        if (json) {
          actionState.warnings.push(message);
        } else {
          defaultRuntime.log(message);
        }
      },
      fail: (message: string, hints?: string[]) => {
        actionState.failed.push({ message, hints });
      },
    };
  },
}));
vi.mock("../../commands/daemon-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/daemon-runtime.js")>()),
  isGatewayDaemonRuntime: mocks.runtime,
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => installService,
  formatGatewayServiceStartRepairIssues: () => "stale service port",
}));
vi.mock("./response.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./response.js")>()),
  buildDaemonServiceSnapshot: vi.fn(),
  installDaemonServiceAndEmit: mocks.install,
}));
const { defaultRuntime, resetRuntimeCapture } = await vi.hoisted(async () => {
  const { createCliRuntimeCapture } = await import("../test-runtime-capture.js");
  return createCliRuntimeCapture();
});
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime,
}));
function readFirstInstallPlanArg() {
  const [firstArg] = mocks.plan.mock.calls[0] ?? [];
  if (!firstArg) {
    throw new Error("Expected gateway install plan arg");
  }
  return firstArg;
}
const { runDaemonInstall } = await import("./install.js");
const envSnapshot = captureFullEnv();
beforeEach(() => {
  for (const mock of [
    ...Object.values(mocks),
    installService.isLoaded,
    installService.install,
    installService.readDefinitionMutationCapability,
    installService.readCommand,
  ]) {
    mock.mockReset();
  }
  mockSystemAccountHome();
  resetRuntimeCapture();
  for (const messages of Object.values(actionState)) {
    messages.length = 0;
  }
  mocks.exec.mockResolvedValue(nodeProbeOutput("26.12.1"));
  mocks.config.mockResolvedValue({
    exists: false,
    valid: true,
    config: {},
    sourceConfig: { gateway: { mode: "local", auth: { mode: "token" } } },
  });
  mocks.plan.mockImplementation(createInstallPlanFixture);
  mocks.tls.mockReturnValue({ NODE_EXTRA_CA_CERTS: undefined, NODE_USE_SYSTEM_CA: undefined });
  delete process.env.OPENCLAW_NIX_MODE;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
});
afterEach(() => {
  vi.restoreAllMocks();
  envSnapshot.restore();
});

export { mocks, actionState, installService, readFirstInstallPlanArg, runDaemonInstall };
