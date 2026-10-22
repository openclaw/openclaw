import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { readEmbeddedGatewayTokenForTest } from "./doctor-service-audit.test-helpers.js";

// Native boundary mocks are shared; each test file registers its own reset/cleanup hooks.
const fsMocks = vi.hoisted(() => ({ realpath: vi.fn() }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: { ...actual, realpath: fsMocks.realpath },
    realpath: fsMocks.realpath,
  };
});

const mocks = vi.hoisted(() => ({
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  stage: vi.fn(),
  install: vi.fn(),
  restart: vi.fn(),
  writeConfig: vi.fn(async (nextConfig: OpenClawConfig) => nextConfig),
  auditGatewayServiceConfig: vi.fn(),
  buildGatewayInstallPlan: vi.fn(),
  resolveGatewayAuthTokenForService: vi.fn(),
  preserveGatewayAuthTokenForService: vi.fn(async () => ({
    ref: { source: "store", provider: "default", id: "SAVED_GATEWAY_TOKEN" },
    reused: false,
  })),
  resolveGatewayPort: vi.fn(() => 18789),
  resolveIsNixMode: vi.fn(() => false),
  isDefaultInstallIdentity: vi.fn(() => true),
  isContainerEnvironment: vi.fn(() => false),
  findExtraGatewayServices: vi.fn().mockResolvedValue({ services: [], errors: [] }),
  renderGatewayServiceCleanupHints: vi.fn().mockReturnValue([]),
  needsNodeRuntimeMigration: vi.fn(() => false),
  renderSystemNodeWarning: vi.fn().mockReturnValue(undefined),
  resolveSystemNodeInfo: vi.fn().mockResolvedValue(null),
  resolveNodeRuntimeInfo: vi.fn(),
  isSystemdUnitActive: vi
    .fn<typeof import("../daemon/systemd-exec.js").isSystemdUnitActive>()
    .mockResolvedValue({ ok: true, value: false }),
  uninstallLegacySystemdUnits: vi.fn().mockResolvedValue([]),
  execLaunchctl: vi.fn(),
  findSystemdGatewayInstallation: vi.fn().mockResolvedValue({ kind: "none" }),
  isSystemUnitActiveAndEnabled: vi.fn().mockResolvedValue(false),
  uninstallUserSystemdGatewayUnit: vi.fn().mockResolvedValue({
    unitName: "openclaw-gateway.service",
    unitPath: "",
    removed: true,
    disabled: true,
  }),
  note: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  isDefaultInstallIdentity: mocks.isDefaultInstallIdentity,
  resolveGatewayPort: mocks.resolveGatewayPort,
  resolveIsNixMode: mocks.resolveIsNixMode,
}));

vi.mock("../daemon/inspect.js", () => ({
  findExtraGatewayServices: mocks.findExtraGatewayServices,
  renderGatewayServiceCleanupHints: mocks.renderGatewayServiceCleanupHints,
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  resolveNodeRuntimeInfo: mocks.resolveNodeRuntimeInfo,
}));

vi.mock("../daemon/service-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/service-audit.js")>();
  return {
    ...actual,
    auditGatewayServiceConfig: mocks.auditGatewayServiceConfig,
    needsNodeRuntimeMigration: mocks.needsNodeRuntimeMigration,
    readEmbeddedGatewayToken: readEmbeddedGatewayTokenForTest,
  };
});

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    readCommand: mocks.readCommand,
    readRuntime: mocks.readRuntime,
    stage: mocks.stage,
    install: mocks.install,
    restart: mocks.restart,
  }),
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUnitActive: mocks.isSystemdUnitActive,
  uninstallLegacySystemdUnits: mocks.uninstallLegacySystemdUnits,
  findSystemdGatewayInstallation: mocks.findSystemdGatewayInstallation,
  isSystemUnitActiveAndEnabled: mocks.isSystemUnitActiveAndEnabled,
  uninstallUserSystemdGatewayUnit: mocks.uninstallUserSystemdGatewayUnit,
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));

vi.mock("../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd-exec.js")>()),
  execLaunchctl: mocks.execLaunchctl,
}));

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note: mocks.note,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
}));

vi.mock("./doctor-gateway-auth-token.js", () => ({
  resolveGatewayAuthTokenForService: mocks.resolveGatewayAuthTokenForService,
  preserveGatewayAuthTokenForService: mocks.preserveGatewayAuthTokenForService,
}));

export { fsMocks, mocks };

export function mockProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function noteMessages(title: string) {
  return mocks.note.mock.calls
    .filter(([, callTitle]) => callTitle === title)
    .map(([message]) => String(message))
    .join("\n");
}

export function expectNoteContaining(messagePart: string, title: string) {
  expect(noteMessages(title)).toContain(messagePart);
}

export function expectNoNoteContaining(messagePart: string, title: string) {
  expect(noteMessages(title)).not.toContain(messagePart);
}
