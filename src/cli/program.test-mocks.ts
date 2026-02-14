import { vi } from "vitest";

export const messageCommand = vi.fn();
export const statusCommand = vi.fn();
export const configureCommand = vi.fn();
export const configureCommandWithSections = vi.fn();
export const setupCommand = vi.fn();
export const onboardCommand = vi.fn();
export const callGateway = vi.fn();
export const runChannelLogin = vi.fn();
export const runChannelLogout = vi.fn();
export const runTui = vi.fn();

export const loadAndMaybeMigrateDoctorConfig = vi.fn();
export const ensureConfigReady = vi.fn();
export const ensurePluginRegistryLoaded = vi.fn();

export const runtime = {
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
