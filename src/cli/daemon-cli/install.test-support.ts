import type { DaemonRuntimePinSnapshot } from "../../daemon/runtime-pin-types.js";
const pinSnapshotMock = vi.hoisted(() =>
  vi.fn<() => DaemonRuntimePinSnapshot>(() => ({ revision: "empty", stored: false })),
);
const pinMigrationMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-pin-state.js")>()),
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, run: () => T) => {
    await pinMigrationMock();
    return run();
  },
  readDaemonRuntimePinForInstall: pinSnapshotMock,
}));
import { afterEach, beforeEach, vi } from "vitest";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import type { ResolvedGatewayAuth } from "../../gateway/auth.js";
import { captureFullEnv } from "../../test-utils/env.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import { createInstallPlanFixture, nodeProbeOutput } from "./install.test-helpers.js";
import type { createDaemonInstallActionContext } from "./shared.js";
type DaemonActionResponse = Parameters<
  ReturnType<typeof createDaemonInstallActionContext>["emit"]
>[0];
const resolveNodeStartupTlsEnvironmentMock = vi.hoisted(() => vi.fn());
const runExecMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn(() => 18789));
const replaceConfigFileMock = vi.hoisted(() => vi.fn());
const resolveGatewayAuthMock = vi.hoisted(() => vi.fn<() => ResolvedGatewayAuth>());
const resolveGatewayBindHostMock = vi.hoisted(() => vi.fn(async () => "127.0.0.1"));
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
const randomTokenMock = vi.hoisted(() => vi.fn(() => "generated-token"));
const buildGatewayInstallPlanMock = vi.hoisted(() => vi.fn<typeof createInstallPlanFixture>());
const isGatewayDaemonRuntimeMock = vi.hoisted(() => vi.fn(() => true));
const installDaemonServiceAndEmitMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../program/config-guard.js", () => ({ ensureConfigReady: ensureConfigReadyMock }));
const actionState = vi.hoisted(() => ({
  warnings: [] as string[],
  emitted: [] as DaemonActionResponse[],
  failed: [] as Array<{ message: string; hints?: string[] }>,
}));
const service = vi.hoisted(() => ({
  loadedText: "loaded",
  isLoaded: vi.fn(async () => false),
  install: vi.fn(async () => {}),
  readDefinitionMutationCapability: vi.fn(async () => ({ kind: "writable" as const })),
  readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(async () => null),
}));
vi.mock("../../bootstrap/node-startup-env.js", () => ({
  resolveNodeStartupTlsEnvironment: resolveNodeStartupTlsEnvironmentMock,
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: runExecMock,
}));
vi.mock("../../config/io.js", () => ({
  readConfigFileSnapshotForWrite: vi.fn(async () => ({
    snapshot: await readConfigFileSnapshotMock(),
    writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
  })),
}));
vi.mock("../../config/mutate.js", () => ({
  replaceConfigFile: replaceConfigFileMock,
}));
vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  resolveGatewayPort: resolveGatewayPortMock,
}));
vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: resolveGatewayAuthMock,
}));
vi.mock("../../gateway/net.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/net.js")>();
  return {
    ...actual,
    resolveGatewayBindHost: resolveGatewayBindHostMock,
  };
});
vi.mock("../../secrets/resolve.js", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
}));
vi.mock("../../commands/random-token.js", () => ({
  randomToken: randomTokenMock,
}));
vi.mock("../../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: buildGatewayInstallPlanMock,
}));
vi.mock("../../daemon/program-args.js", () => ({
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
  isGatewayDaemonRuntime: isGatewayDaemonRuntimeMock,
}));
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));
vi.mock("./response.js", () => ({
  buildDaemonServiceSnapshot: vi.fn(),
  installDaemonServiceAndEmit: installDaemonServiceAndEmitMock,
}));
const { defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();
vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));
export function readFirstInstallPlanArg(): Record<string, unknown> {
  const [firstArg] = buildGatewayInstallPlanMock.mock.calls[0] ?? [];
  if (!firstArg) {
    throw new Error("Expected gateway install plan arg");
  }
  return firstArg as Record<string, unknown>;
}
export const { runDaemonInstall } = await import("./install.js");
const envSnapshot = captureFullEnv();
export function setupInstallTests() {
  beforeEach(() => {
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    pinMigrationMock.mockReset().mockResolvedValue(undefined);
    runExecMock.mockReset().mockResolvedValue(nodeProbeOutput("26.8.1"));
    resolveGatewayPortMock.mockClear();
    mockSystemAccountHome();
    replaceConfigFileMock.mockReset();
    ensureConfigReadyMock.mockReset();
    resetRuntimeCapture();
    for (const messages of Object.values(actionState)) {
      messages.length = 0;
    }

    readConfigFileSnapshotMock.mockReset().mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      sourceConfig: { gateway: { mode: "local", auth: { mode: "token" } } },
    });
    resolveGatewayPortMock.mockReturnValue(18789);
    delete process.env.OPENCLAW_NIX_MODE;
    resolveGatewayAuthMock.mockReset().mockReturnValue({
      mode: "token",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    });
    resolveGatewayBindHostMock.mockReset().mockResolvedValue("127.0.0.1");
    resolveSecretRefValuesMock.mockReset().mockResolvedValue(new Map());
    randomTokenMock.mockReset().mockReturnValue("generated-token");
    buildGatewayInstallPlanMock.mockReset().mockImplementation(createInstallPlanFixture);
    isGatewayDaemonRuntimeMock.mockReset().mockReturnValue(true);
    installDaemonServiceAndEmitMock.mockReset().mockResolvedValue(undefined);
    service.isLoaded.mockReset().mockResolvedValue(false);
    service.install.mockReset().mockResolvedValue(undefined);
    service.readDefinitionMutationCapability.mockReset().mockResolvedValue({ kind: "writable" });
    service.readCommand.mockReset().mockResolvedValue(null);
    resolveNodeStartupTlsEnvironmentMock.mockReset().mockReturnValue({
      NODE_EXTRA_CA_CERTS: undefined,
      NODE_USE_SYSTEM_CA: undefined,
    });
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
  });
}
export {
  actionState,
  buildGatewayInstallPlanMock,
  ensureConfigReadyMock,
  installDaemonServiceAndEmitMock,
  isGatewayDaemonRuntimeMock,
  pinSnapshotMock,
  pinMigrationMock,
  readConfigFileSnapshotMock,
  replaceConfigFileMock,
  resolveGatewayAuthMock,
  resolveGatewayBindHostMock,
  resolveNodeStartupTlsEnvironmentMock,
  runExecMock,
  service,
};
