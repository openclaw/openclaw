import { vi } from "vitest";

type GatewayMockFn = ((opts: unknown) => unknown) & {
  mockReset: () => void;
  mockResolvedValue: (value: unknown) => void;
};

export const callGatewayMock = vi.fn() as GatewayMockFn;

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
