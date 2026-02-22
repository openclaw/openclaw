import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./client-info.js";
import { PROTOCOL_VERSION, validateConnectParams, validateRequestFrame } from "./index.js";

function buildBaseConnectParams() {
  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: GATEWAY_CLIENT_IDS.TEST,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.TEST,
    },
  };
}

describe("gateway protocol connect schema", () => {
  it("accepts a valid connect request frame", () => {
    const frame = {
      type: "req",
      id: "connect-1",
      method: "connect",
      params: buildBaseConnectParams(),
    };
    expect(validateRequestFrame(frame)).toBe(true);
    expect(validateConnectParams(frame.params)).toBe(true);
  });

  it("rejects unknown connect params fields", () => {
    const params = {
      ...buildBaseConnectParams(),
      unexpected: true,
    };
    expect(validateConnectParams(params)).toBe(false);
    expect(
      (validateConnectParams.errors ?? []).some(
        (entry) => entry.keyword === "additionalProperties",
      ),
    ).toBe(true);
  });

  it("rejects overlong connect metadata", () => {
    const params = {
      ...buildBaseConnectParams(),
      client: {
        ...buildBaseConnectParams().client,
        displayName: "x".repeat(257),
      },
    };
    expect(validateConnectParams(params)).toBe(false);
    expect(
      (validateConnectParams.errors ?? []).some(
        (entry) => entry.instancePath === "/client/displayName" && entry.keyword === "maxLength",
      ),
    ).toBe(true);
  });

  it("rejects overlong request frame id and unknown request fields", () => {
    const frame = {
      type: "req",
      id: "x".repeat(129),
      method: "connect",
      params: buildBaseConnectParams(),
      extra: true,
    };
    expect(validateRequestFrame(frame)).toBe(false);
    expect(
      (validateRequestFrame.errors ?? []).some(
        (entry) => entry.keyword === "maxLength" || entry.keyword === "additionalProperties",
      ),
    ).toBe(true);
  });
});
