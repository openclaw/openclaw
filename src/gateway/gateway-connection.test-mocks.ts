import { vi } from "vitest";

type TestMock = ReturnType<typeof vi.fn>;

export const loadConfigMock: TestMock = vi.fn();
export const resolveGatewayPortMock: TestMock = vi.fn();
export const resolveStateDirMock: TestMock = vi.fn(
  (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw",
);
export const resolveConfigPathMock: TestMock = vi.fn(
  (env: NodeJS.ProcessEnv, stateDir: string) =>
    env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`,
);
export const pickPrimaryTailnetIPv4Mock: TestMock = vi.fn();
export const pickPrimaryLanIPv4Mock: TestMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  loadConfig: loadConfigMock,
  resolveGatewayPort: resolveGatewayPortMock,
  resolveStateDir: resolveStateDirMock,
  resolveConfigPath: resolveConfigPathMock,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: pickPrimaryTailnetIPv4Mock,
}));

vi.mock("./net.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./net.js")>();
  return {
    ...actual,
    pickPrimaryLanIPv4: pickPrimaryLanIPv4Mock,
  };
});
