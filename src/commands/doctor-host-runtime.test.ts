import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectGatewayDaemonFindings } from "../flows/doctor-core-checks.runtime.js";
import { maybeRepairGatewayDaemon } from "./doctor-gateway-daemon-flow.js";
import { makeDoctorIo, makeDoctorPrompts } from "./doctor-gateway-runtime.test-utils.js";
import { maybeRepairGatewayServiceConfig } from "./doctor-gateway-services.js";
import { collectNodeRuntimeFindings } from "./node-runtime-diagnostics.js";

const mocks = vi.hoisted(() => ({
  root: vi.fn<() => Promise<string | null>>(),
  readCommand: vi.fn(),
  readGatewayServiceState: vi.fn(),
  detectRuntime: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
  install: vi.fn(),
  restart: vi.fn(),
  writeConfig: vi.fn(),
  buildGatewayInstallPlan: vi.fn(),
  auditGatewayServiceConfig: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
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
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
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
vi.mock("./daemon-install-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemon-install-helpers.js")>()),
  buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
}));
vi.mock("../daemon/service-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service-audit.js")>()),
  auditGatewayServiceConfig: mocks.auditGatewayServiceConfig,
  needsNodeRuntimeMigration: () => true,
}));
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
    JSON.stringify({
      schemaVersion: 1,
      owner: "macos-app",
      displayName: "OpenClaw.app",
      updateHint: "Update OpenClaw.app to update this Gateway.",
    }),
  );
  return root;
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

describe("Doctor host-owned runtime diagnostics", () => {
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
      const command = {
        programArguments: ["/app/bun", path.join(root, "openclaw.mjs"), "gateway", "run"],
        environment: {},
      };
      mocks.readCommand.mockResolvedValue(command);
      mocks.readGatewayServiceState.mockResolvedValue({
        installed: true,
        loadState: { status: "not-loaded" },
        running: false,
        env: {},
        command,
      });
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
    expect(mocks.buildGatewayInstallPlan).not.toHaveBeenCalled();
    expect(mocks.auditGatewayServiceConfig).not.toHaveBeenCalled();
    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.writeConfig).not.toHaveBeenCalled();
    expect(mocks.repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      ownerHint,
      surface === "config" ? "Gateway runtime" : "Gateway",
    );
  });
  it("keeps CLI Node health failures while routing runtime repair to the host", async () => {
    mocks.root.mockResolvedValue(await hostRoot());
    mocks.detectRuntime.mockResolvedValue({
      kind: "node",
      version: "26.8.1",
      execPath: "/fixture/node",
      sqliteProbe: { available: true, version: "3.53.4", text: false, blob: true, json: true },
    });
    expect(await collectNodeRuntimeFindings({})).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("truncates TEXT"),
        fixHint: ownerHint,
      }),
    ]);
  });

  it.each(["Node diagnostics", "daemon diagnostics"])(
    "preserves unsupported service health in %s without recommending runtime replacement",
    async (surface) => {
      const root = await hostRoot();
      const command = {
        programArguments: ["/fixture/node", path.join(root, "openclaw.mjs"), "gateway"],
      };
      mocks.readCommand.mockResolvedValue(command);
      mocks.readGatewayServiceState.mockResolvedValue({
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        env: {},
        command,
      });
      const findings =
        surface === "Node diagnostics"
          ? await collectNodeRuntimeFindings({})
          : await collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } });
      expect(findings).toEqual([
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("unsupported"),
          fixHint: ownerHint,
        }),
      ]);
    },
  );

  it("reports the app owner when an app-hosted Gateway has no native service", async () => {
    mocks.root.mockResolvedValue(await hostRoot());
    expect(await collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } })).toEqual([
      expect.objectContaining({ severity: "info", message: ownerHint }),
    ]);
  });
});
