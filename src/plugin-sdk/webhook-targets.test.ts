import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createWebhookInFlightLimiter } from "./webhook-request-guards.js";
import {
  normalizeWebhookPath,
  registerWebhookTarget,
  registerWebhookTargetWithPluginRoute,
  rejectNonPostWebhookRequest,
  resolveSingleWebhookTarget,
  resolveSingleWebhookTargetAsync,
  resolveWebhookPath,
  resolveWebhookTargetWithAuthOrReject,
  resolveWebhookTargetWithAuthOrRejectSync,
  resolveWebhookTargets,
  withResolvedWebhookRequestPipeline,
} from "./webhook-targets.js";

function createRequest(method: string, url: string): IncomingMessage {
  return Object.assign(new EventEmitter(), { method, url, headers: {} }) as IncomingMessage;
}

function createResponse() {
  const setHeader = vi.fn();
  const end = vi.fn();
  return { res: { statusCode: 200, setHeader, end } as unknown as ServerResponse, setHeader, end };
}

function pipeline(options: Partial<Parameters<typeof withResolvedWebhookRequestPipeline>[0]> = {}) {
  return withResolvedWebhookRequestPipeline({
    req: createPipelineRequest("/hook"),
    res: createResponse().res,
    targetsByPath: new Map([["/hook", [{ id: "A" }]]]),
    allowMethods: ["POST"],
    handle: vi.fn(),
    ...options,
  });
}

const route = {
  auth: "plugin" as const,
  match: "prefix" as const,
  pluginId: "zalo",
  source: "zalo-hosted-media",
  handler: () => {},
};

function createPipelineRequest(url: string): IncomingMessage {
  const req = createRequest("POST", url);
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  return req;
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("webhook paths", () => {
  it("normalizes an empty configured path", () => {
    expect(normalizeWebhookPath("  ")).toBe("/");
  });

  it.each([
    { params: { webhookPath: " explicit/ ", webhookUrl: "invalid" }, expected: "/explicit" },
    {
      params: { webhookUrl: "https://example.test/hook%2Fpart/?q=1#fragment" },
      expected: "/hook%2Fpart",
    },
    { params: { webhookUrl: "invalid", defaultPath: "/fallback/" }, expected: null },
    { params: {}, expected: null },
  ])("resolves callback path from $params", ({ params, expected }) => {
    expect(resolveWebhookPath(params)).toBe(expected);
  });
});

it("runs first/last path lifecycle hooks only at path boundaries", () => {
  const targets = new Map<string, Array<{ path: string; id: string }>>();
  const teardown = vi.fn();
  const onFirstPathTarget = vi.fn(() => teardown);
  const onLastPathTargetRemoved = vi.fn();

  const hooks = { onFirstPathTarget, onLastPathTargetRemoved };
  const registeredA = registerWebhookTarget(targets, { path: "hook", id: "A" }, hooks);
  const registeredB = registerWebhookTarget(targets, { path: "/hook", id: "B" }, hooks);

  expect(onFirstPathTarget.mock.calls).toEqual([[{ path: "/hook", target: registeredA.target }]]);

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

describe("registerWebhookTargetWithPluginRoute", () => {
  it("does not store a target when strict route registration is rejected", () => {
    const registry = createEmptyPluginRegistry();
    const existingRoute = {
      ...route,
      path: "/hook",
      match: "exact" as const,
      pluginId: "existing",
      source: "existing-webhook",
    };
    registry.httpRoutes.push(existingRoute);
    setActivePluginRegistry(registry);
    const targets = new Map<string, Array<{ path: string; id: string }>>();

    expect(() =>
      registerWebhookTargetWithPluginRoute({
        targetsByPath: targets,
        target: { path: "/hook", id: "A" },
        route: {
          ...route,
          match: "exact",
          pluginId: "demo",
          source: "demo-webhook",
          throwOnFailure: true,
        },
      }),
    ).toThrow("route replacement denied");

    expect(targets.size).toBe(0);
    expect(registry.httpRoutes).toEqual([existingRoute]);
  });

  it("keeps one canonical route until the last alias target unregisters", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const targets = new Map<string, Array<{ path: string; id: string }>>();

    const first = registerWebhookTargetWithPluginRoute({
      targetsByPath: targets,
      target: { path: "/Hooks//Zalo/Media/", id: "A" },
      route,
    });
    const second = registerWebhookTargetWithPluginRoute({
      targetsByPath: targets,
      target: { path: "/hooks/zalo/media", id: "B" },
      route,
    });

    const path = "/hooks/zalo/media";
    const expectedTargets = [
      { path, id: "A" },
      { path, id: "B" },
    ];
    expect(targets).toEqual(new Map([[path, expectedTargets]]));
    expect(registry.httpRoutes).toHaveLength(1);

    second.unregister();
    expect(registry.httpRoutes).toHaveLength(1);
    first.unregister();
    expect(registry.httpRoutes).toHaveLength(0);
  });
});

it("resolves a canonical alias after an exact-key miss", () => {
  const targets = new Map([["/hooks/zalo/media", [{ id: "A" }]]]);
  expect(resolveWebhookTargets(createRequest("POST", "/Hooks//Zalo/Media/"), targets)).toEqual({
    path: "/hooks/zalo/media",
    targets: [{ id: "A" }],
  });
});

describe("withResolvedWebhookRequestPipeline", () => {
  it("returns false when request path has no registered targets", async () => {
    const handled = await pipeline({
      req: createRequest("POST", "/missing"),
      targetsByPath: new Map<string, Array<{ id: string }>>(),
    });
    expect(handled).toBe(false);
  });

  it("runs handler when targets resolve and method passes", async () => {
    const handle = vi.fn(async () => {});
    expect(await pipeline({ handle })).toBe(true);
    expect(handle).toHaveBeenCalledWith({ path: "/hook", targets: [{ id: "A" }] });
  });

  it("releases in-flight slot when handler throws", async () => {
    const limiter = createWebhookInFlightLimiter();

    await expect(
      pipeline({
        inFlightLimiter: limiter,
        handle: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    expect(limiter.size()).toBe(0);
  });
});

it("sets 405 for non-POST requests", () => {
  const { res, setHeader, end } = createResponse();

  const rejected = rejectNonPostWebhookRequest(createRequest("GET", "/hook"), res);

  expect(rejected).toBe(true);
  expect(res.statusCode).toBe(405);
  expect(setHeader).toHaveBeenCalledWith("Allow", "POST");
  expect(end).toHaveBeenCalledWith("Method Not Allowed");
});

it("retains a matching falsy target and detects a second match", async () => {
  const target = undefined;
  expect(resolveSingleWebhookTarget([target], () => true)).toEqual({ kind: "single", target });
  await expect(resolveSingleWebhookTargetAsync([target], async () => true)).resolves.toEqual({
    kind: "single",
    target,
  });
  expect(resolveSingleWebhookTarget([target, target], () => true)).toEqual({ kind: "ambiguous" });
  await expect(
    resolveSingleWebhookTargetAsync([target, target], async () => true),
  ).resolves.toEqual({ kind: "ambiguous" });
});

it.each([
  { targets: [{ id: "a" }], matches: false, expectedEnd: "unauthorized" },
  { targets: [{ id: "a" }, { id: "b" }], matches: true, expectedEnd: "ambiguous webhook target" },
])("rejects auth with $expectedEnd", async ({ targets, matches, expectedEnd }) => {
  const { res, end } = createResponse();
  await expect(
    resolveWebhookTargetWithAuthOrReject({ targets, res, isMatch: () => matches }),
  ).resolves.toBeNull();
  expect(res.statusCode).toBe(401);
  expect(end).toHaveBeenCalledWith(expectedEnd);
});

it("returns matched target synchronously", () => {
  const { res } = createResponse();
  const target = resolveWebhookTargetWithAuthOrRejectSync({
    targets: [{ id: "a" }, { id: "b" }],
    res,
    isMatch: (entry) => entry.id === "a",
  });
  expect(target).toEqual({ id: "a" });
});
