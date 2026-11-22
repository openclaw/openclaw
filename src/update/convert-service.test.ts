import { beforeEach, expect, it, vi } from "vitest";
import type * as RuntimePinState from "../daemon/runtime-pin-state.js";
import type * as ServiceLayout from "../daemon/service-layout.js";
import type * as ServiceReconciliation from "../daemon/service-reconciliation.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import type * as Service from "../daemon/service.js";

const mocks = vi.hoisted(() => ({
  readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(),
  stage: vi.fn(),
  matches: vi.fn(),
  reconcile: vi.fn(),
  pin: { pin: undefined },
}));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Service>()),
  resolveGatewayService: () => ({ readCommand: mocks.readCommand, stage: mocks.stage }),
}));
vi.mock("../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimePinState>()),
  withDaemonRuntimePinMigration: async (_env: unknown, run: () => unknown) => run(),
  readDaemonRuntimePinForInstall: () => mocks.pin,
}));
vi.mock("../daemon/service-layout.js", async (original) => ({
  ...(await original<typeof ServiceLayout>()),
  gatewayServiceCommandMatchesRoot: mocks.matches,
}));
vi.mock("../daemon/service-reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ServiceReconciliation>()),
  reconcileGatewayServiceDefinition: mocks.reconcile,
}));
import { stageReleaseService } from "./convert-service.js";

const command: GatewayServiceCommandConfig = {
  programArguments: [
    "/runtime/node",
    "--max-old-space-size=2048",
    "/global/openclaw/dist/index.js",
    "gateway",
    "--port",
    "19999",
  ],
  workingDirectory: "/gateway",
  environment: { OPENCLAW_STATE_DIR: "/private/state", CUSTOM: "retained" },
  sourcePath: "/home/user/.config/systemd/user/openclaw-gateway.service",
};
const params = {
  runningRoot: "/global/openclaw",
  launcher: "/private/state/git-install/openclaw-launcher.mjs",
  env: { HOME: "/home/user" },
  warn: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readCommand.mockResolvedValue(command);
  mocks.matches.mockResolvedValue(true);
  mocks.reconcile.mockImplementation(async (options) => {
    await options.install({ preservePolicy: ["Restart"] });
  });
});

it("stages the launcher through the backup owner without restarting, preserving service arguments and environment", async () => {
  await stageReleaseService(params);
  expect(mocks.reconcile).toHaveBeenCalledWith(
    expect.objectContaining({ command, root: "/global/openclaw" }),
  );
  expect(mocks.stage).toHaveBeenCalledWith(
    expect.objectContaining({
      programArguments: [
        "/runtime/node",
        "--max-old-space-size=2048",
        "/private/state/git-install/openclaw-launcher.mjs",
        "gateway",
        "--port",
        "19999",
      ],
      workingDirectory: "/gateway",
      environment: command.environment,
      preserveAutoStart: true,
      runtimePinUpdate: { expected: mocks.pin, pin: undefined, requireDefinitionMatch: true },
      definitionTransaction: { preservePolicy: ["Restart"] },
    }),
  );
});

it("leaves system-owned and foreign definitions on their forwarding entries", async () => {
  mocks.readCommand.mockResolvedValue({
    ...command,
    sourcePath: "/etc/systemd/system/openclaw.service",
  });
  await stageReleaseService(params);
  mocks.readCommand.mockResolvedValue(command);
  mocks.matches.mockResolvedValue(false);
  await stageReleaseService(params);
  expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(mocks.stage).not.toHaveBeenCalled();
});
