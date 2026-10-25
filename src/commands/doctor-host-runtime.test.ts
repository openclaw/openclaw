import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectGatewayDaemonFindings } from "../flows/doctor-core-checks.runtime.js";
import { maybeRepairGatewayDaemon } from "./doctor-gateway-daemon-flow.js";
import { makeDoctorIo, makeDoctorPrompts } from "./doctor-gateway-runtime.test-utils.js";
import { maybeRepairGatewayServiceConfig } from "./doctor-gateway-services.js";
import { collectNodeRuntimeFindings } from "./node-runtime-diagnostics.js";
import { MACOS_APP_INSTALL_OWNER_MARKER } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  root: vi.fn<() => Promise<string | null>>(),
  readCommand: vi.fn(),
  readGatewayServiceState: vi.fn(),
  detectRuntime: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
  install: vi.fn(),
  restart: vi.fn(),
  writeConfig: vi.fn(),
  repairLaunchAgentBootstrap: vi.fn(),
  note: vi.fn(),
}));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: mocks.root,
}));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => ({
    label: "openclaw-gateway",
    readCommand: mocks.readCommand,
    install: mocks.install,
    restart: mocks.restart,
  }),
  readGatewayServiceState: mocks.readGatewayServiceState,
}));
vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  resolveNodeRuntimeInfo: mocks.resolveNodeRuntimeInfo,
}));
vi.mock("../infra/runtime-guard.js", () => ({ detectRuntime: mocks.detectRuntime }));
vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));
vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
  resolveIsNixMode: () => false,
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../daemon/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd.js")>()),
  repairLaunchAgentBootstrap: mocks.repairLaunchAgentBootstrap,
}));
vi.mock("../infra/ports-inspect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/ports-inspect.js")>()),
  inspectPortUsage: async () => ({ port: 18789, status: "free", listeners: [], hints: [] }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ownerHint = "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.";
async function hostRoot() {
  const root = tempDirs.make("openclaw-doctor-host-runtime-");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.writeFile(path.join(root, "openclaw.mjs"), "");
  await fs.writeFile(
    path.join(root, "openclaw-install-owner.json"),
    MACOS_APP_INSTALL_OWNER_MARKER,
  );
  return root;
}

function setHostService(root: string, running: boolean) {
  const command = {
    programArguments: running
      ? ["/fixture/node", path.join(root, "openclaw.mjs"), "gateway"]
      : ["/app/bun", path.join(root, "openclaw.mjs"), "gateway", "run"],
    ...(!running ? { environment: {} } : {}),
  };
  mocks.readCommand.mockResolvedValue(command);
  mocks.readGatewayServiceState.mockResolvedValue({
    installed: true,
    loadState: { status: running ? "loaded" : "not-loaded" },
    running,
    env: {},
    command,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.root.mockResolvedValue(null);
  mocks.readCommand.mockResolvedValue(null);
  mocks.detectRuntime.mockResolvedValue({ kind: "bun" });
  mocks.resolveNodeRuntimeInfo.mockResolvedValue({
    status: "unsupported",
    version: "22.23.2",
    capabilityError: "Node SQLite is unsupported.",
  });
  mocks.readGatewayServiceState.mockResolvedValue({
    installed: false,
    loadState: { status: "not-loaded" },
    command: null,
  });
});

it.each([
  { owner: "CLI", surface: "config" },
  { owner: "service", surface: "config" },
  { owner: "CLI", surface: "daemon" },
  { owner: "service", surface: "daemon" },
])("leaves $owner-owned $surface repairs with the app", async ({ owner, surface }) => {
  const root = await hostRoot();
  if (owner === "CLI") {
    mocks.root.mockResolvedValue(root);
  } else {
    setHostService(root, false);
  }
  const runtime = makeDoctorIo();
  const prompter = makeDoctorPrompts();
  if (surface === "config") {
    await maybeRepairGatewayServiceConfig({ gateway: {} }, "local", runtime, prompter, {
      writeConfig: mocks.writeConfig,
    });
  } else {
    await maybeRepairGatewayDaemon({
      cfg: { gateway: { mode: "local" } },
      runtime,
      prompter,
      options: {},
      healthOk: false,
      gatewayDetailsMessage: "Gateway is unavailable.",
    });
  }
  expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.restart).not.toHaveBeenCalled();
  expect(mocks.writeConfig).not.toHaveBeenCalled();
  expect(mocks.repairLaunchAgentBootstrap).not.toHaveBeenCalled();
  expect(mocks.note).toHaveBeenCalledWith(
    ownerHint,
    surface === "config" ? "Gateway runtime" : "Gateway",
  );
});
it.each([
  { mode: "CLI TEXT", surface: "node", severity: "error", message: "truncates TEXT" },
  { mode: "service", surface: "node", severity: "warning", message: "unsupported" },
  { mode: "service", surface: "daemon", severity: "warning", message: "unsupported" },
  { mode: "CLI only", surface: "daemon", severity: "info", message: ownerHint },
])(
  "reports $mode health through $surface with host-owned repair",
  async ({ mode, surface, severity, message }) => {
    const root = await hostRoot();
    if (mode === "service") {
      setHostService(root, true);
    } else {
      mocks.root.mockResolvedValue(root);
    }
    if (mode === "CLI TEXT") {
      mocks.detectRuntime.mockResolvedValue({
        kind: "node",
        version: "26.8.1",
        execPath: "/fixture/node",
        sqliteProbe: { available: true, version: "3.53.4", text: false, blob: true, json: true },
      });
    }
    const findings =
      surface === "node"
        ? await collectNodeRuntimeFindings({})
        : await collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } });
    expect(findings).toEqual([
      expect.objectContaining({
        severity,
        message: mode === "CLI only" ? message : expect.stringContaining(message),
        ...(mode !== "CLI only" ? { fixHint: ownerHint } : {}),
      }),
    ]);
  },
);
