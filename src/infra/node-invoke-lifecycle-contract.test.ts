import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validateNodeInvokeProgressParams,
  validateNodeInvokeResultParams,
} from "../../packages/gateway-protocol/src/index.js";
import type fixtureData from "../../test/fixtures/node-invoke-lifecycle-contract.json";
import {
  buildNodeInvokeCancel,
  buildNodeInvokeInput,
  buildNodeInvokeRequest,
} from "../gateway/node-invoke-request.js";
import {
  coerceNodeInvokeCancelPayload,
  coerceNodeInvokeInputPayload,
  coerceNodeInvokePayload,
} from "../node-host/invoke-payload.js";

const fixture: typeof fixtureData = JSON.parse(
  fs.readFileSync(
    new URL("../../test/fixtures/node-invoke-lifecycle-contract.json", import.meta.url),
    "utf8",
  ),
);

describe("node invocation lifecycle contract", () => {
  it("matches the Gateway request producer and node-host consumer", () => {
    expect(fixture.version).toBe(3);
    const request = fixture.request.canonical;
    expect(
      buildNodeInvokeRequest({
        id: request.id,
        nodeId: request.nodeId,
        command: request.command,
        timeoutMs: request.timeoutMs,
        idempotencyKey: request.idempotencyKey,
        sessionKey: request.sessionKey,
      }),
    ).toEqual(request);
    expect(coerceNodeInvokePayload(request)).toEqual(request);
    expect(fixture.request.withExtensions).toHaveProperty("unexpected", true);
    expect(coerceNodeInvokePayload(fixture.request.withExtensions)).toEqual(request);
    expect(coerceNodeInvokePayload(fixture.request.legacyParams)).toEqual({
      id: "invoke-legacy",
      nodeId: "node-1",
      command: "example.status",
      paramsJSON: '{"verbose":true}',
      timeoutMs: null,
      idempotencyKey: null,
    });
    expect(coerceNodeInvokePayload(fixture.request.ambiguousParams)).toEqual({
      id: "invoke-ambiguous",
      nodeId: "node-1",
      command: "example.status",
      paramsJSON: '{"current":true}',
      timeoutMs: null,
      idempotencyKey: null,
    });
    expect(coerceNodeInvokePayload(fixture.request.invalid)).toBeNull();
  });

  it("matches input and cancellation payload handling", () => {
    for (const input of fixture.input.canonical) {
      expect(
        buildNodeInvokeInput({
          invokeId: input.id,
          nodeId: input.nodeId,
          seq: input.seq,
          payloadJSON: input.payloadJSON,
        }),
      ).toEqual(input);
      expect(coerceNodeInvokeInputPayload(input)).toEqual({
        invokeId: input.id,
        nodeId: input.nodeId,
        seq: input.seq,
        payloadJSON: input.payloadJSON,
      });
    }
    expect(coerceNodeInvokeInputPayload(fixture.input.invalid)).toBeNull();
    expect(buildNodeInvokeCancel(fixture.cancel.canonical)).toEqual(fixture.cancel.canonical);
    expect(coerceNodeInvokeCancelPayload(fixture.cancel.canonical)).toEqual(
      fixture.cancel.canonical,
    );
    expect(coerceNodeInvokeCancelPayload(fixture.cancel.invalid)).toBeNull();
  });

  it("matches progress and result validation", () => {
    expect(validateNodeInvokeProgressParams(fixture.progress.canonical)).toBe(true);
    expect(fixture.progress.invalid).toBeDefined();
    expect(validateNodeInvokeProgressParams(fixture.progress.invalid)).toBe(false);
    expect(validateNodeInvokeResultParams(fixture.results.success)).toBe(true);
    expect(validateNodeInvokeResultParams(fixture.results.failure)).toBe(true);
    expect(fixture.results.invalid).toBeDefined();
    expect(validateNodeInvokeResultParams(fixture.results.invalid)).toBe(false);
  });
});
