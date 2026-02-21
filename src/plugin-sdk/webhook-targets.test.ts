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
  it("returns none when no target matches", () => {
    const result = resolveSingleWebhookTarget(["a", "b"], (value) => value === "c");
    expect(result).toEqual({ kind: "none" });
  });

  it("returns the single match", () => {
    const result = resolveSingleWebhookTarget(["a", "b"], (value) => value === "b");
    expect(result).toEqual({ kind: "single", target: "b" });
  });

  it("returns ambiguous after second match", () => {
    const calls: string[] = [];
    const result = resolveSingleWebhookTarget(["a", "b", "c"], (value) => {
      calls.push(value);
      return value === "a" || value === "b";
    });
    expect(result).toEqual({ kind: "ambiguous" });
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("resolveSingleWebhookTargetAsync", () => {
  it("returns none when no target matches", async () => {
    const result = await resolveSingleWebhookTargetAsync(
      ["a", "b"],
      async (value) => value === "c",
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("returns the single async match", async () => {
    const result = await resolveSingleWebhookTargetAsync(
      ["a", "b"],
      async (value) => value === "b",
    );
    expect(result).toEqual({ kind: "single", target: "b" });
  });

  it("returns ambiguous after second async match", async () => {
    const calls: string[] = [];
    const result = await resolveSingleWebhookTargetAsync(["a", "b", "c"], async (value) => {
      calls.push(value);
      return value === "a" || value === "b";
    });
    expect(result).toEqual({ kind: "ambiguous" });
    expect(calls).toEqual(["a", "b"]);
  });
});
