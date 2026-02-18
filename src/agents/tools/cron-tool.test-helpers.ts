import { vi } from "vitest";

export const callGatewayMock = vi.fn();

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
