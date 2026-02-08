import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { hitlApprovalManager } from "../infra/hitl/state.js";

const { handleHitlCallbackHttpRequest } = await import("./hitl-http.js");

function makeReq(params: { url: string; method?: string; body: unknown }): IncomingMessage {
  const raw = JSON.stringify(params.body);
  const stream = new Readable({
    read() {
      this.push(raw);
      this.push(null);
    },
  });
  const req = stream as unknown as IncomingMessage;
  req.url = params.url;
  req.method = params.method ?? "POST";
  req.headers = { host: "localhost" };
  // @ts-expect-error test shim
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function makeRes(): { res: ServerResponse; end: (value?: unknown) => void } {
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => {},
    end: () => {},
  } as unknown as ServerResponse;
  return { res, end: res.end.bind(res) };
}

describe("handleHitlCallbackHttpRequest", () => {
  it("resolves pending approvals on request.completed", async () => {
    const record = hitlApprovalManager.create({
      kind: "outbound",
      timeoutMs: 10_000,
      summary: { test: true },
      defaultDecision: "deny",
      id: null,
    });
    const decisionPromise = hitlApprovalManager.waitForDecision(record, 10_000);
    hitlApprovalManager.attachHitlRequestId(record.id, "r1");

    const { res } = makeRes();
    const req = makeReq({
      url: "/hitl/callback/secret",
      body: {
        event: "request.completed",
        request_id: "r1",
        status: "completed",
        response_data: { selected_value: "allow-once" },
        response_by: { name: "Alice" },
      },
    });
    const handled = await handleHitlCallbackHttpRequest(req, res, {
      callbackSecret: "secret",
      maxBodyBytes: 32 * 1024,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    await expect(decisionPromise).resolves.toBe("allow-once");
  });

  it("uses default decision on request.timeout", async () => {
    const record = hitlApprovalManager.create({
      kind: "outbound",
      timeoutMs: 10_000,
      summary: { test: true },
      defaultDecision: "deny",
      id: null,
    });
    const decisionPromise = hitlApprovalManager.waitForDecision(record, 10_000);
    hitlApprovalManager.attachHitlRequestId(record.id, "r2");

    const { res } = makeRes();
    const req = makeReq({
      url: "/hitl/callback/secret",
      body: {
        event: "request.timeout",
        request_id: "r2",
        status: "timeout",
        response_data: null,
        response_by: null,
      },
    });
    const handled = await handleHitlCallbackHttpRequest(req, res, {
      callbackSecret: "secret",
      maxBodyBytes: 32 * 1024,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    await expect(decisionPromise).resolves.toBe("deny");
  });

  it("rejects invalid payloads", async () => {
    const { res } = makeRes();
    const req = makeReq({ url: "/hitl/callback/secret", body: { hello: "world" } });
    const handled = await handleHitlCallbackHttpRequest(req, res, {
      callbackSecret: "secret",
      maxBodyBytes: 32 * 1024,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
  });
});
