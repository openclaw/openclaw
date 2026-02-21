import { vi } from "vitest";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";

export const callGatewayMock: MockFn = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));
