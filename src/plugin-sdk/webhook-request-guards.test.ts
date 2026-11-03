/**
 * Tests webhook request guard body parsing and rejection behavior.
 */
import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueCommandInLane } from "../process/command-queue.js";
import {
  captureGatewayRootWorkReleaseObserver,
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { createFixedWindowRateLimiter } from "./webhook-memory-guards.js";
import {
  applyBasicWebhookRequestGuards,
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  isJsonContentType,
  readWebhookBodyOrReject,
  readJsonWebhookBodyOrReject,
  runDetachedWebhookWork,
} from "./webhook-request-guards.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
  pause: () => MockIncomingMessage;
};

function createMockRequest(params: {
  method?: string;
  headers?: Record<string, string>;
  chunks?: string[];
  emitEnd?: boolean;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = params.method ?? "POST";
  req.headers = params.headers ?? {};
  req.socket = new Socket();
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];
  req.pause = (() => req) as MockIncomingMessage["pause"];

  if (params.chunks) {
    void Promise.resolve().then(() => {
      for (const chunk of params.chunks ?? []) {
        req.emit("data", Buffer.from(chunk, "utf-8"));
      }
      if (params.emitEnd !== false) {
        req.emit("end");
      }
    });
  }

  return req;
}

async function readJsonBody(chunks: string[], emptyObjectOnEmpty = false) {
  const req = createMockRequest({ chunks });
  const res = createMockServerResponse();
  return {
    result: await readJsonWebhookBodyOrReject({
      req,
      res,
      maxBytes: 1024,
      emptyObjectOnEmpty,
    }),
    res,
  };
}

async function readRawBody(params: Parameters<typeof createMockRequest>[0], profile?: "pre-auth") {
  const req = createMockRequest(params);
  const res = createMockServerResponse();
  return {
    result: await readWebhookBodyOrReject({
      req,
      res,
      profile,
    }),
    res,
  };
}

describe("isJsonContentType", () => {
  it.each([{ name: "rejects missing media types", input: undefined, expected: false }])(
    "$name",
    ({ input, expected }) => {
      expect(isJsonContentType(input)).toBe(expected);
    },
  );
});

describe("applyBasicWebhookRequestGuards", () => {
  it("rejects disallowed HTTP methods", () => {
    const req = createMockRequest({ method: "GET" });
    const res = createMockServerResponse();
    const ok = applyBasicWebhookRequestGuards({
      req,
      res,
      allowMethods: ["POST"],
    });
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("POST");
  });

  it("enforces rate limits", () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      maxTrackedKeys: 10,
    });
    const req1 = createMockRequest({ method: "POST" });
    const res1 = createMockServerResponse();
    const req2 = createMockRequest({ method: "POST" });
    const res2 = createMockServerResponse();
    expect(
      applyBasicWebhookRequestGuards({
        req: req1,
        res: res1,
        rateLimiter: limiter,
        rateLimitKey: "k",
        nowMs: 1_000,
      }),
    ).toBe(true);
    expect(
      applyBasicWebhookRequestGuards({
        req: req2,
        res: res2,
        rateLimiter: limiter,
        rateLimitKey: "k",
        nowMs: 1_001,
      }),
    ).toBe(false);
    expect(res2.statusCode).toBe(429);
  });

  it.each([
    {
      name: "rejects non-json requests when required",
      req: createMockRequest({
        method: "POST",
        headers: { "content-type": "text/plain" },
      }),
      expectedOk: false,
      expectedStatusCode: 415,
    },
  ])("$name", ({ req, expectedOk, expectedStatusCode }) => {
    const res = createMockServerResponse();
    const ok = applyBasicWebhookRequestGuards({
      req,
      res,
      requireJsonContentType: true,
    });
    expect(ok).toBe(expectedOk);
    expect(res.statusCode).toBe(expectedStatusCode);
  });
});

describe("readJsonWebhookBodyOrReject", () => {
  it.each([
    {
      name: "returns parsed JSON body",
      chunks: ['{"ok":true}'],
      expected: { ok: true, value: { ok: true } },
      expectedStatusCode: 200,
      expectedBody: undefined,
    },
    {
      name: "writes 400 on invalid JSON payload",
      chunks: ["{bad json"],
      expected: { ok: false },
      expectedStatusCode: 400,
      expectedBody: "Bad Request",
    },
  ])("$name", async ({ chunks, expected, expectedStatusCode, expectedBody }) => {
    const { result, res } = await readJsonBody(chunks);
    expect(result).toEqual(expected);
    expect(res.statusCode).toBe(expectedStatusCode);
    expect(res.body).toBe(expectedBody);
  });
});

describe("readWebhookBodyOrReject", () => {
  it("returns raw body contents", async () => {
    const { result } = await readRawBody({ chunks: ["plain text"] });
    expect(result).toEqual({ ok: true, value: "plain text" });
  });
});

describe("beginWebhookRequestPipelineOrReject", () => {
  it("falls back for non-finite in-flight limiter options", () => {
    const limiter = createWebhookInFlightLimiter({
      maxInFlightPerKey: Number.NaN,
      maxTrackedKeys: Number.NaN,
    });
    const releases: Array<() => void> = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        const result = beginWebhookRequestPipelineOrReject({
          req: createMockRequest({ method: "POST" }),
          res: createMockServerResponse(),
          allowMethods: ["POST"],
          inFlightLimiter: limiter,
          inFlightKey: "ip:127.0.0.1",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          releases.push(result.release);
        }
      }

      const overflowRes = createMockServerResponse();
      const overflow = beginWebhookRequestPipelineOrReject({
        req: createMockRequest({ method: "POST" }),
        res: overflowRes,
        allowMethods: ["POST"],
        inFlightLimiter: limiter,
        inFlightKey: "ip:127.0.0.1",
      });

      expect(overflow.ok).toBe(false);
      expect(overflowRes.statusCode).toBe(429);
    } finally {
      for (const release of releases) {
        release();
      }
    }
  });

  it("enforces in-flight request limits and releases slots", () => {
    const limiter = createWebhookInFlightLimiter({
      maxInFlightPerKey: 1,
      maxTrackedKeys: 10,
    });

    const first = beginWebhookRequestPipelineOrReject({
      req: createMockRequest({ method: "POST" }),
      res: createMockServerResponse(),
      allowMethods: ["POST"],
      inFlightLimiter: limiter,
      inFlightKey: "ip:127.0.0.1",
    });
    expect(first.ok).toBe(true);

    const secondRes = createMockServerResponse();
    const second = beginWebhookRequestPipelineOrReject({
      req: createMockRequest({ method: "POST" }),
      res: secondRes,
      allowMethods: ["POST"],
      inFlightLimiter: limiter,
      inFlightKey: "ip:127.0.0.1",
    });
    expect(second.ok).toBe(false);
    expect(secondRes.statusCode).toBe(429);

    if (first.ok) {
      first.release();
    }

    const third = beginWebhookRequestPipelineOrReject({
      req: createMockRequest({ method: "POST" }),
      res: createMockServerResponse(),
      allowMethods: ["POST"],
      inFlightLimiter: limiter,
      inFlightKey: "ip:127.0.0.1",
    });
    expect(third.ok).toBe(true);
    if (third.ok) {
      third.release();
    }
  });
});

describe("runDetachedWebhookWork", () => {
  afterEach(resetGatewayWorkAdmission);
  it("defers the callback until the request handler can acknowledge", async () => {
    const { runWithGatewayHttpWorkAdmission } =
      await import("../gateway/server/http-work-admission.js");
    const order: string[] = [];
    const detached: Promise<void>[] = [];

    await runWithGatewayHttpWorkAdmission(
      new ServerResponse(new IncomingMessage(new Socket())),
      async () => {
        detached.push(
          runDetachedWebhookWork(async () => {
            order.push("work");
          }),
        );
        order.push("ack");
        expect(order).toEqual(["ack"]);
        return true;
      },
    );

    await Promise.all(detached);
    expect(order).toEqual(["ack", "work"]);
  });

  it.each([
    ["detached", "accepting", true],
    ["inherited", "accepting", false],
    ["detached", "suspended", true],
    ["detached", "restarting", false],
  ] as const)("owns %s post-ack cleanup while %s", async (kind, phase, allowed) => {
    const { runWithGatewayHttpWorkAdmission } =
      await import("../gateway/server/http-work-admission.js");
    const cleanupStarted = createDeferredCore();
    const execute = createDeferredCore();
    const released = createDeferredCore();
    const deliver = vi.fn(async () => 42);
    let continued: Promise<number> | undefined;
    try {
      await runWithGatewayHttpWorkAdmission(
        new ServerResponse(new IncomingMessage(new Socket())),
        async () => {
          const run =
            kind === "detached" ? runDetachedWebhookWork : (work: () => Promise<number>) => work();
          continued = run(async () => {
            const observeRelease = expectDefined(
              captureGatewayRootWorkReleaseObserver(),
              "work root observer",
            );
            observeRelease(() => released.resolve());
            cleanupStarted.resolve();
            await execute.promise;
            return await enqueueCommandInLane(`${kind}-webhook-work-test`, deliver);
          });
          void continued.catch(() => {});
          return true;
        },
      );
      await cleanupStarted.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(kind === "detached" ? 1 : 0);
      expect(deliver).not.toHaveBeenCalled();
      if (phase === "suspended") {
        expect(tryBeginGatewaySuspendAdmission(() => {})).not.toBeNull();
        expect(tryBeginGatewayRootWorkAdmission("new-input")).toBeNull();
      } else if (phase === "restarting") {
        markGatewayRestartDraining();
      }
      execute.resolve();
      if (allowed) {
        await expect(continued).resolves.toBe(42);
        expect(deliver).toHaveBeenCalledOnce();
      } else {
        await expect(continued).rejects.toBeInstanceOf(GatewayDrainingError);
        expect(deliver).not.toHaveBeenCalled();
      }
      await released.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      execute.resolve();
      await Promise.allSettled([continued]);
    }
  });

  it("refuses a new detached callback when restart has closed admission", async () => {
    const work = vi.fn(async () => 42);
    markGatewayRestartDraining();
    await expect(runDetachedWebhookWork(work)).rejects.toBeInstanceOf(GatewayDrainingError);
    expect(work).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("keeps tracked work accepted after the caller's async work scope closes", async () => {
    const { runWithGatewayHttpWorkAdmission } =
      await import("../gateway/server/http-work-admission.js");
    const { AsyncWorkScope, captureAsyncWorkTracker } =
      await import("../shared/async-work-scope.js");

    const parentScope = new AsyncWorkScope();
    let detached: Promise<string> | undefined;
    await runWithGatewayHttpWorkAdmission(
      new ServerResponse(new IncomingMessage(new Socket())),
      async () =>
        // Deferred post-ack work starts under the request's async work scope; that
        // scope closes once the triggering turn settles, but the detached callback
        // must still be able to run and track embedded work afterwards.
        await parentScope.track(async () => {
          detached = runDetachedWebhookWork(async () => {
            const trackOwner = captureAsyncWorkTracker();
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 25);
            });
            return await trackOwner(async () => "tracked-after-close");
          });
          return true;
        }),
    );

    parentScope.beginClose();
    await parentScope.drain();
    await expect(detached).resolves.toBe("tracked-after-close");
  });
});
