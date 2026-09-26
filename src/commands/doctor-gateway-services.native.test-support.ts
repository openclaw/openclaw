import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  readEmbeddedGatewayTokenForTest,
  testServiceAuditCodes,
} from "./doctor-service-audit.test-helpers.js";

// Native boundary mocks are shared; each test file registers its own reset/cleanup hooks.
const fsMocks = vi.hoisted(() => ({
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      realpath: fsMocks.realpath,
    },
    realpath: fsMocks.realpath,
  };
});

const mocks = vi.hoisted(() => ({
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  stage: vi.fn(),
  install: vi.fn(),
  restart: vi.fn(),
  writeConfig: vi.fn<(nextConfig: OpenClawConfig) => Promise<OpenClawConfig>>(
    async (nextConfig) => nextConfig,
  ),
  auditGatewayServiceConfig: vi.fn(),
  buildGatewayInstallPlan: vi.fn(),
  resolveGatewayAuthTokenForService: vi.fn(),
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

vi.mock("../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: mocks.auditGatewayServiceConfig,
  needsNodeRuntimeMigration: mocks.needsNodeRuntimeMigration,
  readEmbeddedGatewayToken: readEmbeddedGatewayTokenForTest,
  SERVICE_AUDIT_CODES: {
    gatewayCommandMissing: testServiceAuditCodes.gatewayCommandMissing,
    gatewayEntrypointMismatch: testServiceAuditCodes.gatewayEntrypointMismatch,
    gatewayManagedEnvEmbedded: testServiceAuditCodes.gatewayManagedEnvEmbedded,
    gatewayPathMissing: "gateway-path-missing",
    gatewayPathMissingDirs: "gateway-path-missing-dirs",
    gatewayPathNonMinimal: "gateway-path-nonminimal",
    gatewayPortMismatch: testServiceAuditCodes.gatewayPortMismatch,
    gatewayProxyEnvEmbedded: testServiceAuditCodes.gatewayProxyEnvEmbedded,
    gatewayRuntimeProbeFailed: "gateway-runtime-probe-failed",
    gatewayTokenDrift: "gateway-token-drift",
    gatewayTokenEmbedded: "gateway-token-embedded",
    gatewayPasswordEmbedded: "gateway-password-embedded",
    gatewayTokenMismatch: testServiceAuditCodes.gatewayTokenMismatch,
    systemdUnitBackupUnsafe: "systemd-unit-backup-unsafe",
  },
}));

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

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
}));

vi.mock("./doctor-gateway-auth-token.js", () => ({
  resolveGatewayAuthTokenForService: mocks.resolveGatewayAuthTokenForService,
}));

export { fsMocks, mocks };

export function mockProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

export function expectNoteContaining(messagePart: string, title: string) {
  const messages = mocks.note.mock.calls
    .filter(([, callTitle]) => callTitle === title)
    .map(([message]) => String(message));
  expect(messages.join("\n")).toContain(messagePart);
}

export function expectNoNoteContaining(messagePart: string, title: string) {
  const messages = mocks.note.mock.calls
    .filter(([, callTitle]) => callTitle === title)
    .map(([message]) => String(message));
  expect(messages.join("\n")).not.toContain(messagePart);
}
