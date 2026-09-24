import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateNodeInvokeProgressParams,
  validateNodeInvokeResultParams,
} from "../../packages/gateway-protocol/src/index.js";
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

type InvokeRequest = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON: string | null;
  timeoutMs: number;
  idempotencyKey: string;
  sessionKey: string;
};

type InvokeInput = {
  id: string;
  nodeId: string;
  seq: number;
  payloadJSON: string;
};

type InvokeCancel = {
  invokeId: string;
  nodeId: string;
};

type LifecycleFixture = {
  version: number;
  request: {
    canonical: InvokeRequest;
    withExtensions: InvokeRequest & Record<string, unknown>;
    legacyParams: Record<string, unknown>;
    ambiguousParams: Record<string, unknown>;
    invalid: Record<string, unknown>;
  };
  input: {
    canonical: InvokeInput[];
    invalid: Record<string, unknown>;
  };
  progress: {
    canonical: Record<string, unknown>;
    invalid: Record<string, unknown>;
  };
  results: {
    success: Record<string, unknown>;
    failure: Record<string, unknown>;
    invalid: Record<string, unknown>;
  };
  cancel: {
    canonical: InvokeCancel;
    invalid: Record<string, unknown>;
  };
};

function loadFixture(): LifecycleFixture {
  const fixturePath = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "node-invoke-lifecycle-contract.json",
  );
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as LifecycleFixture;
}

describe("node invocation lifecycle contract", () => {
  const fixture = loadFixture();

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
