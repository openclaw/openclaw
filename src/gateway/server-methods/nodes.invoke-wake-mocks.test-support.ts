import { vi } from "vitest";

type MockNodeCommandPolicyParams = {
  command: string;
  declaredCommands?: string[];
  allowlist: Set<string>;
};

export type MockNodeConfig = {
  gateway?: {
    nodes?: {
      commands?: {
        allow?: string[];
        deny?: string[];
      };
    };
  };
};

const mocks = vi.hoisted(() => ({
  captureNodePairingGeneration: vi.fn(),
  getRuntimeConfig: vi.fn(() => ({})),
  isNodePairingGenerationCurrent: vi.fn(),
  resolveNodeCommandAllowlist: vi.fn<(cfg: MockNodeConfig) => Set<string>>(() => new Set()),
  isNodeCommandAllowed: vi.fn<
    (params: MockNodeCommandPolicyParams) => { ok: true } | { ok: false; reason: string }
  >(() => ({ ok: true })),
  isForegroundRestrictedPluginNodeCommand: vi.fn((command: string) =>
    command.startsWith("canvas."),
  ),
  sanitizeNodeInvokeParamsForForwarding: vi.fn(
    ({
      rawParams,
    }: {
      rawParams: unknown;
    }): {
      ok: boolean;
      params: unknown;
      approvalAuthority?: { recordId: string; decision: "allow-once" | "allow-always" };
    } => ({
      ok: true,
      params: rawParams,
    }),
  ),
  clearApnsRegistrationIfCurrent: vi.fn(),
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
  sendApnsAlert: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
  requestNodePairing: vi.fn(),
}));

export { mocks };

vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: mocks.captureNodePairingGeneration,
  isNodePairingGenerationCurrent: mocks.isNodePairingGenerationCurrent,
}));

vi.mock("../node-command-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../node-command-policy.js")>()),
  DEFAULT_DANGEROUS_NODE_COMMANDS: ["sms.send", "sms.search"],
  resolveNodeCommandAllowlist: mocks.resolveNodeCommandAllowlist,
  isNodeCommandAllowed: mocks.isNodeCommandAllowed,
  isForegroundRestrictedPluginNodeCommand: mocks.isForegroundRestrictedPluginNodeCommand,
}));

vi.mock("../node-invoke-sanitize.js", () => ({
  sanitizeNodeInvokeParamsForForwarding: mocks.sanitizeNodeInvokeParamsForForwarding,
}));

vi.mock("../../infra/push-apns.js", () => ({
  clearApnsRegistrationIfCurrent: mocks.clearApnsRegistrationIfCurrent,
  loadApnsRegistration: mocks.loadApnsRegistration,
  resolveApnsAuthConfigFromEnv: mocks.resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv: mocks.resolveApnsRelayConfigFromEnv,
  sendApnsBackgroundWake: mocks.sendApnsBackgroundWake,
  sendApnsAlert: mocks.sendApnsAlert,
  shouldClearStoredApnsRegistration: mocks.shouldClearStoredApnsRegistration,
}));

vi.mock("../../infra/device-pairing-node.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing-node.js")>(
    "../../infra/device-pairing-node.js",
  );
  return {
    ...actual,
    requestNodePairing: mocks.requestNodePairing,
  };
});
