import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/gateway-rpc.js")>();
  return {
    ...actual,
    callGatewayFromCliWithTransport: mocks.callGateway,
  };
});

import { sessionsProcessesListCommand } from "./sessions-processes.js";

beforeEach(() => {
  vi.clearAllMocks();
});

it("exits non-zero on Gateway failure without inventing process rows", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  await sessionsProcessesListCommand({ key: "agent:main:main", json: true }, mocks.runtime);
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  const payload = JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0] ?? "{}"));
  expect(payload).toMatchObject({
    ok: false,
    error: { type: "cli_error", message: "gateway unavailable" },
  });
});
