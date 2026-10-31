import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";

const callGateway = vi.hoisted(() => vi.fn());

// mock-isolation: exercise node resolution without opening an actual Gateway connection.
vi.mock("../gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: callGateway,
}));

import {
  buildNodeInvokeParams,
  parseOptionalNodeFiniteNumber,
  parseOptionalNodeInteger,
  resolveCliNode,
  resolveNodeDiagnosticsId,
} from "./rpc.js";

function requestError(params: ConstructorParameters<typeof GatewayClientRequestError>[0]) {
  return new GatewayClientRequestError({
    code: params.code ?? "INVALID_REQUEST",
    message: params.message ?? "unknown method: node.list",
    ...params,
  });
}
const calledMethods = () => callGateway.mock.calls.map(([method]) => method);
const paired = (nodeId: string, displayName: string, platform?: string) => ({
  pending: [],
  paired: [{ nodeId, displayName, ...(platform ? { platform } : {}) }],
});

describe("node inventory resolution", () => {
  beforeEach(() => {
    callGateway.mockReset();
  });

  it("uses paired records when an older Gateway rejects the exact node.list method", async () => {
    callGateway
      .mockRejectedValueOnce(requestError({}))
      .mockResolvedValueOnce(paired("legacy-node", "Legacy Node", "ios"));

    await expect(resolveCliNode({}, "Legacy Node")).resolves.toMatchObject({
      nodeId: "legacy-node",
      displayName: "Legacy Node",
    });
    expect(calledMethods()).toEqual(["node.list", "node.pair.list"]);
  });

  it.each([
    {
      label: "an authorization rejection",
      error: requestError({ code: "UNAUTHORIZED", message: "operator authorization required" }),
    },
    { label: "malformed request retry metadata", error: requestError({ retryAfterMs: -1 }) },
  ])("preserves $label without consulting stale paired nodes", async ({ error }) => {
    callGateway
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(paired("stale-node", "Stale Node"));

    await expect(resolveCliNode({}, "Stale Node")).rejects.toBe(error);
    expect(calledMethods()).toEqual(["node.list"]);
  });

  it("keeps diagnostics on the same exact missing-method contract", async () => {
    const error = requestError({ message: "unknown method: node.list.extra" });
    callGateway.mockRejectedValueOnce(error);

    await expect(resolveNodeDiagnosticsId({}, "stale-node")).rejects.toBe(error);
    expect(calledMethods()).toEqual(["node.list"]);
  });

  it("rejects explicit blank --timeout before transport", async () => {
    await expect(resolveCliNode({ timeout: "" }, "some-node")).rejects.toThrow(/Invalid --timeout/);
    expect(callGateway).not.toHaveBeenCalled();
  });
});

describe("node invoke envelope", () => {
  it("preserves caller-owned invoke fields and params identity", () => {
    const params = { url: "openclaw://widget/local" };
    const input = {
      nodeId: "mac-1",
      command: "canvas.present",
      params,
      idempotencyKey: "caller-supplied-key",
      timeoutMs: 35_000,
    };
    const result = buildNodeInvokeParams(input);
    expect(result).toEqual(input);
    expect(result.params).toBe(params);
  });

  it("retains undefined params while generating an idempotency key", () => {
    const result = buildNodeInvokeParams({ nodeId: "mac-1", command: "canvas.hide" });

    expect(result).not.toHaveProperty("timeoutMs");
    expect(result).toHaveProperty("params", undefined);
    expect(result.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

describe("node numeric option parsing", () => {
  it.each([
    ["positive integer", parseOptionalNodeInteger],
    [
      "non-negative integer",
      (value: unknown, flag: string) => parseOptionalNodeInteger(value, flag, "non-negative"),
    ],
    ["finite number", parseOptionalNodeFiniteNumber],
  ] as const)("parses optional %s values", (kind, parse) => {
    expect(() => parse("", "--value")).toThrow(`--value must be a ${kind}`);
    expect(parse(null, "--value")).toBeUndefined();
  });
});
