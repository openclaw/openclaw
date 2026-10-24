import { Command } from "commander";
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

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: mocks.runtime,
  };
});

import { presenceQueryCommand } from "./presence-query.js";
import { registerPresenceCommand } from "../cli/program/register.presence.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callGateway.mockResolvedValue({
    observedAt: 1,
    status: "ok",
    people: [],
    totalPeople: 0,
    truncated: false,
  });
});

async function parseQuery(...args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerPresenceCommand(program);
  await program.parseAsync(["presence", "query", ...args], { from: "user" });
}

function loggedJson() {
  return JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0] ?? "{}"));
}

it("prints presence.query JSON when targeting via registered --port", async () => {
  await parseQuery("--port", "18794", "--token", "tok", "--timeout", "12000", "--json");
  expect(loggedJson()).toMatchObject({
    status: "ok",
    people: [],
    totalPeople: 0,
    truncated: false,
  });
  expect(mocks.callGateway.mock.calls[0]?.[0]).toBe("presence.query");
  expect(mocks.callGateway.mock.calls[0]?.[1]).toEqual(
    expect.objectContaining({
      port: "18794",
      token: "tok",
      timeout: "12000",
      json: true,
    }),
  );
});

it("prints person query JSON and forwards --url targeting through the registered CLI", async () => {
  await parseQuery(
    "--action",
    "person",
    "--person",
    "me",
    "--include",
    "devices",
    "--include",
    "network",
    "--url",
    "ws://127.0.0.1:18794",
    "--token",
    "tok",
    "--json",
  );
  expect(loggedJson()).toMatchObject({ status: "ok", people: [], totalPeople: 0 });
  expect(mocks.callGateway.mock.calls[0]?.[1]).toEqual(
    expect.objectContaining({
      url: "ws://127.0.0.1:18794",
      token: "tok",
      json: true,
    }),
  );
  expect(mocks.callGateway.mock.calls[0]?.[2]).toEqual({
    action: "person",
    person: "me",
    include: ["devices", "network"],
  });
});

it("exits non-zero on Gateway failure without inventing presence rows", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  await presenceQueryCommand(mocks.runtime, { json: true });
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  expect(loggedJson()).toMatchObject({
    ok: false,
    error: { type: "cli_error", message: "gateway unavailable" },
  });
});
