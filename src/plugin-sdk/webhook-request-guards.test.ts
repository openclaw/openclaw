import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
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
      req.emit("end");
    });
  }

  return req;
}

async function readJsonBody(chunks: string[]) {
  const req = createMockRequest({ chunks });
  const res = createMockServerResponse();
  return {
    result: await readJsonWebhookBodyOrReject({
      req,
      res,
      maxBytes: 1024,
      emptyObjectOnEmpty: false,
    }),
    res,
  };
}

function pipeline(
  inFlightLimiter: ReturnType<typeof createWebhookInFlightLimiter>,
  res = createMockServerResponse(),
) {
  return beginWebhookRequestPipelineOrReject({
    req: createMockRequest({}),
    res,
    allowMethods: ["POST"],
    inFlightLimiter,
    inFlightKey: "ip:127.0.0.1",
  });
}

async function admitted(run: () => Promise<boolean>) {
  const { runWithGatewayHttpWorkAdmission } =
    await import("../gateway/server/http-work-admission.js");
  return runWithGatewayHttpWorkAdmission(
    new ServerResponse(new IncomingMessage(new Socket())),
    run,
  );
}

const postAckDelay = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });

it("rejects missing media types", () => {
  expect(isJsonContentType(undefined)).toBe(false);
});

describe("applyBasicWebhookRequestGuards", () => {
  it("rejects disallowed HTTP methods", () => {
    const req = createMockRequest({ method: "GET" });
    const res = createMockServerResponse();
    const ok = applyBasicWebhookRequestGuards({ req, res, allowMethods: ["POST"] });
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
    const res1 = createMockServerResponse();
    const res2 = createMockServerResponse();
    const guard = (res: typeof res1, nowMs: number) =>
      applyBasicWebhookRequestGuards({
        req: createMockRequest({}),
        res,
        rateLimiter: limiter,
        rateLimitKey: "k",
        nowMs,
      });
    expect(guard(res1, 1_000)).toBe(true);
    expect(guard(res2, 1_001)).toBe(false);
    expect(res2.statusCode).toBe(429);
  });

  it("rejects non-json requests when required", () => {
    const req = createMockRequest({ headers: { "content-type": "text/plain" } });
    const res = createMockServerResponse();
    const ok = applyBasicWebhookRequestGuards({
      req,
      res,
      requireJsonContentType: true,
    });
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(415);
  });
});

describe("readJsonWebhookBodyOrReject", () => {
  it.each([
    ["parsed", '{"ok":true}', { ok: true, value: { ok: true } }, 200, undefined],
    ["invalid", "{bad json", { ok: false }, 400, "Bad Request"],
  ] as const)("handles %s JSON bodies", async (_name, chunk, expected, statusCode, body) => {
    const { result, res } = await readJsonBody([chunk]);
    expect(result).toEqual(expected);
    expect(res.statusCode).toBe(statusCode);
    expect(res.body).toBe(body);
  });
});

it("returns raw webhook body contents", async () => {
  const result = await readWebhookBodyOrReject({
    req: createMockRequest({ chunks: ["plain text"] }),
    res: createMockServerResponse(),
  });
  expect(result).toEqual({ ok: true, value: "plain text" });
});

describe("beginWebhookRequestPipelineOrReject", () => {
  it.each([
    ["non-finite defaults", Number.NaN, Number.NaN, 8],
    ["explicit limits", 1, 10, 1],
  ] as const)("enforces and releases %s", (_name, maxInFlightPerKey, maxTrackedKeys, capacity) => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey, maxTrackedKeys });
    const releases: Array<() => void> = [];
    try {
      for (let index = 0; index < capacity; index += 1) {
        const result = pipeline(limiter);
        expect(result.ok).toBe(true);
        if (result.ok) {
          releases.push(result.release);
        }
      }

      const overflowRes = createMockServerResponse();
      const overflow = pipeline(limiter, overflowRes);

      expect(overflow.ok).toBe(false);
      expect(overflowRes.statusCode).toBe(429);
      releases.shift()?.();
      const next = pipeline(limiter);
      expect(next.ok).toBe(true);
      if (next.ok) {
        releases.push(next.release);
      }
    } finally {
      for (const release of releases) {
        release();
      }
    }
  });
});

describe("runDetachedWebhookWork", () => {
  it("defers the callback until the request handler can acknowledge", async () => {
    const order: string[] = [];
    const detached: Promise<void>[] = [];

    await admitted(async () => {
      detached.push(
        runDetachedWebhookWork(async () => {
          order.push("work");
        }),
      );
      order.push("ack");
      expect(order).toEqual(["ack"]);
      return true;
    });

    await Promise.all(detached);
    expect(order).toEqual(["ack", "work"]);
  });

  it.each([
    ["detached", runDetachedWebhookWork, true],
    ["inherited", (run: () => Promise<number>) => run(), false],
  ] as const)("checks %s post-ack admission after request release", async (kind, run, allowed) => {
    const { enqueueCommandInLane } = await import("../process/command-queue.js");
    let continued: Promise<number> | undefined;
    await admitted(async () => {
      continued = run(async () => {
        await postAckDelay();
        return await enqueueCommandInLane(`${kind}-webhook-work-test`, async () => 42);
      });
      continued.catch(() => {});
      return true;
    });
    if (allowed) {
      await expect(continued).resolves.toBe(42);
    } else {
      await expect(continued).rejects.toThrow(
        "Gateway is temporarily unavailable. Please try again shortly.",
      );
    }
  });

  it("keeps tracked work accepted after the caller's async work scope closes", async () => {
    const { AsyncWorkScope, captureAsyncWorkTracker } =
      await import("../shared/async-work-scope.js");

    const parentScope = new AsyncWorkScope();
    let detached: Promise<string> | undefined;
    await admitted(
      async () =>
        // Detached tracking must outlive the request's async work scope.
        await parentScope.track(async () => {
          detached = runDetachedWebhookWork(async () => {
            const trackOwner = captureAsyncWorkTracker();
            await postAckDelay();
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
