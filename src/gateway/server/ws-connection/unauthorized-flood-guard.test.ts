import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../../packages/gateway-protocol/src/index.js";
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
  return {
    ...harness,
    async respond(responseError: ErrorShape | null = unauthorized) {
      const error = responseError ?? undefined;
      mocks.handleGatewayRequest.mockImplementationOnce(({ respond }) => {
        respond(error === undefined, undefined, error);
      });
      const id = String(++sequence);
      await harness.dispatcher.dispatch({ type: "req", id, method: "health", params: {} }, client);
      expect(harness.send).toHaveBeenLastCalledWith({
        type: "res",
        id,
        ok: error === undefined,
        payload: undefined,
        error,
      });
    },
  };
}

function responseLogs() {
  return mocks.logWs.mock.calls.flatMap(([direction, kind, meta]) =>
    direction === "out" && kind === "res" ? [typeof meta === "function" ? meta() : meta] : [],
  );
}

describe("authenticated WebSocket unauthorized-role floods", () => {
  it("sends every response, suppresses repeated logs, and closes after the threshold", async () => {
    const connection = createConnection();
    for (let count = 1; count <= 10; count += 1) {
      await connection.respond();
    }
    expect(connection.close).not.toHaveBeenCalled();
    expect(responseLogs()).toHaveLength(1);
    expect(responseLogs()[0]).toMatchObject({ unauthorizedCount: 1 });

    await connection.respond();
    expect(connection.close).toHaveBeenCalledExactlyOnceWith(1008, "repeated unauthorized calls");
    expect(connection.setCloseCause).toHaveBeenLastCalledWith("repeated-unauthorized-requests", {
      unauthorizedCount: 11,
      method: "health",
    });
    expect(responseLogs()[1]).toMatchObject({
      unauthorizedCount: 11,
      suppressedUnauthorizedResponses: 9,
    });

    await connection.respond();
    expect(connection.send).toHaveBeenCalledTimes(12);
    expect(connection.close).toHaveBeenCalledTimes(2);
    expect(responseLogs()).toHaveLength(3);
    expect(responseLogs()[2]).toMatchObject({ unauthorizedCount: 12 });
    expect(responseLogs()[2]).not.toHaveProperty("suppressedUnauthorizedResponses");
  });

  it("resets the counter after a successful response", async () => {
    const connection = createConnection();
    for (let count = 0; count < 10; count += 1) {
      await connection.respond();
    }
    await connection.respond(null);
    for (let count = 0; count < 10; count += 1) {
      await connection.respond();
    }
    expect(connection.close).not.toHaveBeenCalled();
    expect(responseLogs().map((entry) => entry?.unauthorizedCount)).toEqual([1, undefined, 1]);
    await connection.respond();
    expect(connection.close).toHaveBeenCalledExactlyOnceWith(1008, "repeated unauthorized calls");
  });

  it("keeps counters owned by their connection", async () => {
    const first = createConnection("first-connection");
    const second = createConnection("second-connection");
    for (let count = 0; count < 10; count += 1) {
      await first.respond();
    }
    await second.respond();
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
    expect(responseLogs().map((entry) => [entry?.connId, entry?.unauthorizedCount])).toEqual([
      ["first-connection", 1],
      ["second-connection", 1],
    ]);
  });

  it.each([
    errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin"),
    errorShape(ErrorCodes.UNAVAILABLE, "service unavailable"),
  ])("does not count non-role errors: $message", async (error) => {
    const connection = createConnection();
    await connection.respond();
    for (let count = 0; count < 12; count += 1) {
      await connection.respond(error);
    }
    await connection.respond();
    expect(connection.close).not.toHaveBeenCalled();
    expect(responseLogs()).toHaveLength(14);
    expect(
      responseLogs()
        .slice(1, 13)
        .every((entry) => entry?.unauthorizedCount === undefined),
    ).toBe(true);
    expect(responseLogs()[13]).toMatchObject({ unauthorizedCount: 1 });
  });
});
