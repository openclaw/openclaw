import { vi } from "vitest";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";

export const callGatewayMock = vi.fn() as unknown as MockFn;

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));
