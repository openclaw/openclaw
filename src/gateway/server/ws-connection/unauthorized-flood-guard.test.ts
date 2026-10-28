import { afterEach, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

const mocks = vi.hoisted(() => ({
  handleGatewayRequest: vi.fn<(options: GatewayRequestOptions) => void>(),
  logWs: vi.fn<typeof import("../../ws-log.js").logWs>(),
}));

// mock-isolation: Inject exact response errors without loading or dispatching real Gateway methods.
vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
  handleGatewayRequest: mocks.handleGatewayRequest,
}));
// mock-isolation: Flood accounting owns no shared request queue or scheduling budget.
vi.mock("./request-start.js", () => ({
  scheduleGatewayRequestStart: () => Promise.resolve(),
}));
vi.mock("../../ws-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ws-log.js")>()),
  logWs: mocks.logWs,
}));

afterEach(() => {
  mocks.handleGatewayRequest.mockReset();
  mocks.logWs.mockClear();
});

const unauthorized = errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized role: node");

function createConnection(connId = "flood-test-connection") {
  const client = createOperatorWsClient({ connId });
  const harness = createDispatchTestHarness({ connId });
  let sequence = 0;
  async function respond(count = 1, responseError: typeof unauthorized | null = unauthorized) {
    const error = responseError ?? undefined;
    for (let index = 0; index < count; index += 1) {
      mocks.handleGatewayRequest.mockImplementationOnce(({ respond: publish }) => {
        publish(error === undefined, undefined, error);
      });
      const id = String(++sequence);
      await harness.dispatcher.dispatch({ type: "req", id, method: "health", params: {} }, client);
      const response = { type: "res", id, ok: error === undefined, payload: undefined, error };
      expect(harness.send).toHaveBeenLastCalledWith(response);
    }
  }
  return { ...harness, respond };
}

function responseLogs() {
  return mocks.logWs.mock.calls.flatMap(([direction, kind, meta]) =>
    direction === "out" && kind === "res" ? [typeof meta === "function" ? meta() : meta] : [],
  );
}

it("sends every response, suppresses repeated logs, and closes after the threshold", async () => {
  const connection = createConnection();
  await connection.respond(10);
  expect(connection.close).not.toHaveBeenCalled();
  expect(responseLogs()).toMatchObject([{ unauthorizedCount: 1 }]);

  await connection.respond();
  expect(connection.close).toHaveBeenCalledExactlyOnceWith(1008, "repeated unauthorized calls");
  expect(connection.setCloseCause).toHaveBeenLastCalledWith("repeated-unauthorized-requests", {
    unauthorizedCount: 11,
    method: "health",
  });
  await connection.respond();
  expect(connection.send).toHaveBeenCalledTimes(12);
  expect(connection.close).toHaveBeenCalledTimes(2);
  expect(responseLogs()).toMatchObject([
    { unauthorizedCount: 1 },
    { unauthorizedCount: 11, suppressedUnauthorizedResponses: 9 },
    { unauthorizedCount: 12 },
  ]);
  expect(responseLogs()[2]).not.toHaveProperty("suppressedUnauthorizedResponses");
});

it("keeps counters owned by their connection", async () => {
  const first = createConnection("first-connection");
  const second = createConnection("second-connection");
  await first.respond(10);
  await second.respond();
  expect(first.close).not.toHaveBeenCalled();
  expect(second.close).not.toHaveBeenCalled();
  expect(responseLogs().map((entry) => [entry?.connId, entry?.unauthorizedCount])).toEqual([
    ["first-connection", 1],
    ["second-connection", 1],
  ]);
});

it.each([
  null,
  errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin"),
  errorShape(ErrorCodes.UNAVAILABLE, "service unavailable"),
])("resets the counter on non-role responses: %j", async (error) => {
  const connection = createConnection();
  await connection.respond(10);
  await connection.respond(12, error);
  await connection.respond(10);
  expect(connection.close).not.toHaveBeenCalled();
  const counts = responseLogs().map((entry) => entry?.unauthorizedCount);
  expect(counts).toEqual([1, ...Array(12).fill(undefined), 1]);
  await connection.respond();
  expect(connection.close).toHaveBeenCalledExactlyOnceWith(1008, "repeated unauthorized calls");
});
