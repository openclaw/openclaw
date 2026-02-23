import { vi } from "vitest";

export const loadConfigMock = vi.fn();
export const resolveGatewayPortMock = vi.fn();
export const pickPrimaryTailnetIPv4Mock = vi.fn();
export const pickPrimaryLanIPv4Mock = vi.fn();

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
