import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  registerWebhookTarget,
  rejectNonPostWebhookRequest,
  resolveSingleWebhookTarget,
  resolveSingleWebhookTargetAsync,
  resolveWebhookTargets,
} from "./webhook-targets.js";

function createRequest(method: string, url: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

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
