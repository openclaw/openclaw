import { vi } from "vitest";

type GatewayMockFn = ((opts: unknown) => unknown) & {
  mockReset: () => void;
  mockResolvedValue: (value: unknown) => void;
};

const makeGatewayMock = (): GatewayMockFn => vi.fn() as unknown as GatewayMockFn;

export const callGatewayMock: GatewayMockFn = makeGatewayMock();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));

export function resetCronToolGatewayMock() {
  callGatewayMock.mockReset();
  callGatewayMock.mockResolvedValue({ ok: true });
}
