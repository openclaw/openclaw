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

import { sessionsStorageCommand } from "./sessions-storage.js";

const inventory = {
  agents: [
    {
      agentId: "main",
      storePath: "/tmp/openclaw-agent.sqlite",
      hotTranscripts: 2,
      coldTranscripts: 1,
      databaseBytes: 10,
      walBytes: 0,
      archiveBytes: 4,
      embeddedArchiveBytes: 0,
    },
  ],
  maintenance: {
    running: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    archivedTranscripts: 0,
    externalizedTranscripts: 0,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callGateway.mockResolvedValue(inventory);
});

it.each(["status", "run"] as const)(
  "forwards sessions.storage.%s with empty params and prints JSON",
  async (operation) => {
    await sessionsStorageCommand(
      operation,
      {
        url: "ws://gateway.test",
        token: "tok",
        password: "pw",
        timeout: "12000",
        json: true,
      },
      mocks.runtime,
    );
    expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
      `sessions.storage.${operation}`,
      {
        url: "ws://gateway.test",
        token: "tok",
        password: "pw",
        timeout: "12000",
        json: true,
      },
      {},
      { defaultTimeoutMs: 30_000 },
    );
    expect(mocks.runtime.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(inventory, null, 2));
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  },
);

it("exits non-zero on Gateway failure without inventing local inventory", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  await sessionsStorageCommand("status", { json: true }, mocks.runtime);
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  const payload = JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0] ?? "{}"));
  expect(payload).toMatchObject({
    ok: false,
    error: { type: "cli_error", message: "gateway unavailable" },
  });
});
