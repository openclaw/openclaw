import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createWebhookInFlightLimiter } from "./webhook-request-guards.js";
import {
  registerWebhookTarget,
  registerWebhookTargetWithPluginRoute,
  rejectNonPostWebhookRequest,
  resolveSingleWebhookTarget,
  resolveSingleWebhookTargetAsync,
  resolveWebhookTargetWithAuthOrReject,
  resolveWebhookTargetWithAuthOrRejectSync,
  resolveWebhookTargets,
  withResolvedWebhookRequestPipeline,
} from "./webhook-targets.js";

function createRequest(method: string, url: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("registerWebhookTarget", () => {
  it("normalizes the path and unregisters cleanly", () => {
    const targets = new Map<string, Array<{ path: string; id: string }>>();
    const registered = registerWebhookTarget(targets, {
      path: "hook",
      id: "A",
    });

    expect(registered.target.path).toBe("/hook");
    expect(targets.get("/hook")).toEqual([registered.target]);

    registered.unregister();
    expect(targets.has("/hook")).toBe(false);
  });

  it("runs first/last path lifecycle hooks only at path boundaries", () => {
    const targets = new Map<string, Array<{ path: string; id: string }>>();
    const teardown = vi.fn();
    const onFirstPathTarget = vi.fn(() => teardown);
    const onLastPathTargetRemoved = vi.fn();

    const registeredA = registerWebhookTarget(
      targets,
      { path: "hook", id: "A" },
      { onFirstPathTarget, onLastPathTargetRemoved },
    );
    const registeredB = registerWebhookTarget(
      targets,
      { path: "/hook", id: "B" },
      { onFirstPathTarget, onLastPathTargetRemoved },
    );

    expect(onFirstPathTarget).toHaveBeenCalledTimes(1);
    expect(onFirstPathTarget).toHaveBeenCalledWith({
      path: "/hook",
      target: expect.objectContaining({ id: "A", path: "/hook" }),
    });

    registeredB.unregister();
    expect(teardown).not.toHaveBeenCalled();
    expect(onLastPathTargetRemoved).not.toHaveBeenCalled();

    registeredA.unregister();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(onLastPathTargetRemoved).toHaveBeenCalledTimes(1);
    expect(onLastPathTargetRemoved).toHaveBeenCalledWith({ path: "/hook" });

    registeredA.unregister();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(onLastPathTargetRemoved).toHaveBeenCalledTimes(1);
  });

  it("does not register target when first-path hook throws", () => {
    const targets = new Map<string, Array<{ path: string; id: string }>>();
    expect(() =>
      registerWebhookTarget(
        targets,
        { path: "/hook", id: "A" },
        {
          onFirstPathTarget: () => {
            throw new Error("boom");
          },
        },
      ),
    ).toThrow("boom");
    expect(targets.has("/hook")).toBe(false);
  });
});

describe("registerWebhookTargetWithPluginRoute", () => {
  it("registers plugin route on first target and removes it on last target", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const targets = new Map<string, Array<{ path: string; id: string }>>();

    const registeredA = registerWebhookTargetWithPluginRoute({
      targetsByPath: targets,
      target: { path: "/hook", id: "A" },
      route: {
        auth: "plugin",
        pluginId: "demo",
        source: "demo-webhook",
        handler: () => {},
      },
    });
    const registeredB = registerWebhookTargetWithPluginRoute({
      targetsByPath: targets,
      target: { path: "/hook", id: "B" },
      route: {
        auth: "plugin",
        pluginId: "demo",
        source: "demo-webhook",
        handler: () => {},
      },
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]).toEqual(
      expect.objectContaining({
        pluginId: "demo",
        path: "/hook",
        source: "demo-webhook",
      }),
    );

    registeredA.unregister();
    expect(registry.httpRoutes).toHaveLength(1);
    registeredB.unregister();
    expect(registry.httpRoutes).toHaveLength(0);
  });
});

describe("resolveWebhookTargets", () => {
  it("resolves normalized path targets", () => {
    const targets = new Map<string, Array<{ id: string }>>();
    targets.set("/hook", [{ id: "A" }]);

    expect(resolveWebhookTargets(createRequest("POST", "/hook/"), targets)).toEqual({
      path: "/hook",
      targets: [{ id: "A" }],
    });
  });

  it("returns null when path has no targets", () => {
    const targets = new Map<string, Array<{ id: string }>>();
    expect(resolveWebhookTargets(createRequest("POST", "/missing"), targets)).toBeNull();
  });
});

describe("withResolvedWebhookRequestPipeline", () => {
  it("returns false when request path has no registered targets", async () => {
    const req = createRequest("POST", "/missing");
    req.headers = {};
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    const handled = await withResolvedWebhookRequestPipeline({
      req,
      res,
      targetsByPath: new Map<string, Array<{ id: string }>>(),
      allowMethods: ["POST"],
      handle: vi.fn(),
    });
    expect(handled).toBe(false);
  });

  it("runs handler when targets resolve and method passes", async () => {
    const req = createRequest("POST", "/hook");
    req.headers = {};
    (req as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress: "127.0.0.1",
    };
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    const handle = vi.fn(async () => {});
    const handled = await withResolvedWebhookRequestPipeline({
      req,
      res,
      targetsByPath: new Map([["/hook", [{ id: "A" }]]]),
      allowMethods: ["POST"],
      handle,
    });
    expect(handled).toBe(true);
    expect(handle).toHaveBeenCalledWith({ path: "/hook", targets: [{ id: "A" }] });
  });

  it("releases in-flight slot when handler throws", async () => {
    const req = createRequest("POST", "/hook");
    req.headers = {};
    (req as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress: "127.0.0.1",
    };
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    const limiter = createWebhookInFlightLimiter();

    await expect(
      withResolvedWebhookRequestPipeline({
        req,
        res,
        targetsByPath: new Map([["/hook", [{ id: "A" }]]]),
        allowMethods: ["POST"],
        inFlightLimiter: limiter,
        handle: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    expect(limiter.size()).toBe(0);
  });
});

describe("rejectNonPostWebhookRequest", () => {
  it("sets 405 for non-POST requests", () => {
    const setHeaderMock = vi.fn();
    const endMock = vi.fn();
    const res = {
      statusCode: 200,
      setHeader: setHeaderMock,
      end: endMock,
    } as unknown as ServerResponse;

    const rejected = rejectNonPostWebhookRequest(createRequest("GET", "/hook"), res);

    expect(rejected).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(setHeaderMock).toHaveBeenCalledWith("Allow", "POST");
    expect(endMock).toHaveBeenCalledWith("Method Not Allowed");
  });
});

describe("resolveSingleWebhookTarget", () => {
  const resolvers: Array<{
    name: string;
    run: (
      targets: readonly string[],
      isMatch: (value: string) => boolean | Promise<boolean>,
    ) => Promise<{ kind: "none" } | { kind: "single"; target: string } | { kind: "ambiguous" }>;
  }> = [
    {
      name: "sync",
      run: async (targets, isMatch) =>
        resolveSingleWebhookTarget(targets, (value) => Boolean(isMatch(value))),
    },
    {
      name: "async",
      run: (targets, isMatch) =>
        resolveSingleWebhookTargetAsync(targets, async (value) => Boolean(await isMatch(value))),
    },
  ];

  it.each(resolvers)("returns none when no target matches ($name)", async ({ run }) => {
    const result = await run(["a", "b"], (value) => value === "c");
    expect(result).toEqual({ kind: "none" });
  });

  it.each(resolvers)("returns the single match ($name)", async ({ run }) => {
    const result = await run(["a", "b"], (value) => value === "b");
    expect(result).toEqual({ kind: "single", target: "b" });
  });

  it.each(resolvers)("returns ambiguous after second match ($name)", async ({ run }) => {
    const calls: string[] = [];
    const result = await run(["a", "b", "c"], (value) => {
      calls.push(value);
      return value === "a" || value === "b";
    });
    expect(result).toEqual({ kind: "ambiguous" });
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("resolveWebhookTargetWithAuthOrReject", () => {
  it("returns matched target", async () => {
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    await expect(
      resolveWebhookTargetWithAuthOrReject({
        targets: [{ id: "a" }, { id: "b" }],
        res,
        isMatch: (target) => target.id === "b",
      }),
    ).resolves.toEqual({ id: "b" });
  });

  it("writes unauthorized response on no match", async () => {
    const endMock = vi.fn();
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: endMock,
    } as unknown as ServerResponse;
    await expect(
      resolveWebhookTargetWithAuthOrReject({
        targets: [{ id: "a" }],
        res,
        isMatch: () => false,
      }),
    ).resolves.toBeNull();
    expect(res.statusCode).toBe(401);
    expect(endMock).toHaveBeenCalledWith("unauthorized");
  });

  it("writes ambiguous response on multi-match", async () => {
    const endMock = vi.fn();
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: endMock,
    } as unknown as ServerResponse;
    await expect(
      resolveWebhookTargetWithAuthOrReject({
        targets: [{ id: "a" }, { id: "b" }],
        res,
        isMatch: () => true,
      }),
    ).resolves.toBeNull();
    expect(res.statusCode).toBe(401);
    expect(endMock).toHaveBeenCalledWith("ambiguous webhook target");
  });
});

describe("resolveWebhookTargetWithAuthOrRejectSync", () => {
  it("returns matched target synchronously", () => {
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    const target = resolveWebhookTargetWithAuthOrRejectSync({
      targets: [{ id: "a" }, { id: "b" }],
      res,
      isMatch: (entry) => entry.id === "a",
    });
    expect(target).toEqual({ id: "a" });
  });
});
