import { vi, type Mock } from "vitest";

export const messageCommand: Mock = vi.fn();
export const statusCommand: Mock = vi.fn();
export const configureCommand: Mock = vi.fn();
export const configureCommandWithSections: Mock = vi.fn();
export const setupCommand: Mock = vi.fn();
export const onboardCommand: Mock = vi.fn();
export const callGateway: Mock = vi.fn();
export const runChannelLogin: Mock = vi.fn();
export const runChannelLogout: Mock = vi.fn();
export const runTui: Mock = vi.fn();

export const loadAndMaybeMigrateDoctorConfig: Mock = vi.fn();
export const ensureConfigReady: Mock = vi.fn();
export const ensurePluginRegistryLoaded: Mock = vi.fn();

export const runtime: { log: Mock; error: Mock; exit: Mock<() => never> } = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

export function installBaseProgramMocks() {
  vi.mock("../commands/message.js", () => ({ messageCommand }));
  vi.mock("../commands/status.js", () => ({ statusCommand }));
  vi.mock("../commands/configure.js", () => ({
    CONFIGURE_WIZARD_SECTIONS: [
      "workspace",
      "model",
      "web",
      "gateway",
      "daemon",
      "channels",
      "skills",
      "health",
    ],
    configureCommand,
    configureCommandWithSections,
  }));
  vi.mock("../commands/setup.js", () => ({ setupCommand }));
  vi.mock("../commands/onboard.js", () => ({ onboardCommand }));
  vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
  vi.mock("./channel-auth.js", () => ({ runChannelLogin, runChannelLogout }));
  vi.mock("../tui/tui.js", () => ({ runTui }));
  vi.mock("../gateway/call.js", () => ({
    callGateway,
    randomIdempotencyKey: () => "idem-test",
    buildGatewayConnectionDetails: () => ({
      url: "ws://127.0.0.1:1234",
      urlSource: "test",
      message: "Gateway target: ws://127.0.0.1:1234",
    }),
  }));
  vi.mock("./deps.js", () => ({ createDefaultDeps: () => ({}) }));
}

export function installSmokeProgramMocks() {
  vi.mock("./plugin-registry.js", () => ({ ensurePluginRegistryLoaded }));
  vi.mock("../commands/doctor-config-flow.js", () => ({
    loadAndMaybeMigrateDoctorConfig,
  }));
  vi.mock("./program/config-guard.js", () => ({ ensureConfigReady }));
  vi.mock("./preaction.js", () => ({ registerPreActionHooks: () => {} }));
}
