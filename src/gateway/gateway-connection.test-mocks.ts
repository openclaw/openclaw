import { vi } from "vitest";

type TestMock = ReturnType<typeof vi.fn>;

export const loadConfigMock: TestMock = vi.fn();
export const resolveGatewayPortMock: TestMock = vi.fn();
export const pickPrimaryTailnetIPv4Mock: TestMock = vi.fn();
export const pickPrimaryLanIPv4Mock: TestMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
    resolveGatewayPort: resolveGatewayPortMock,
  };
});

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
