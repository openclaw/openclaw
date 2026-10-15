// @vitest-environment node
import type { SessionsResolveResult } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { loadChatRoute } from "./route-loader.ts";
import {
  createSessionRouteContext,
  sessionRouteKey,
  sessionRouteListResult,
} from "./route-resolution.test-support.ts";

const location = { pathname: "/chat/roboclaw/original-title-12345678", search: "", hash: "" };
const resolved: SessionsResolveResult = {
  ok: true,
  key: sessionRouteKey,
  agentId: "roboclaw",
  displayName: "Current title",
};

function fixture() {
  const harness = createSessionRouteContext();
  const reply = createDeferred<SessionsResolveResult>();
  const requestStarted = createDeferred();
  const controller = new AbortController();
  harness.context.gateway.snapshot.hello = gatewayHelloForMethods([
    "sessions.resolve",
    "sessions.subscribe",
    "sessions.list",
  ]);
  harness.context.gateway.snapshot.selfUser = { id: "reader" };
  harness.request.mockImplementation(async (method) => {
    if (method === "sessions.resolve") {
      requestStarted.resolve();
      return reply.promise;
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      return sessionRouteListResult([]);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const started = () => requestStarted.promise;
  return { ...harness, reply, controller, started };
}

describe("short-route resolution ownership", () => {
  it("resolves and canonicalizes a cold route once after hello", async () => {
    const h = fixture();
    const { client, hello } = h.context.gateway.snapshot;
    h.publishGateway({ phase: "connecting", client: null, hello: null });
    const waiting = createDeferred();
    const subscribe = h.context.gateway.subscribe;
    vi.spyOn(h.context.gateway, "subscribe").mockImplementation((listener) => {
      const stop = subscribe(listener);
      waiting.resolve();
      return stop;
    });
    const pending = loadChatRoute(h.context, location, "chat", h.controller.signal);
    await waiting.promise;
    h.publishGateway({ phase: "connected", client, hello });
    await h.started();
    h.reply.resolve(resolved);
    const data = await pending;
    if (!("kind" in data) || data.kind !== "session" || !data.canonicalLocation) {
      throw new Error("Expected a canonical session location");
    }
    expect(data.canonicalLocation.pathname).toBe("/chat/roboclaw/current-title-12345678");
    await expect(
      loadChatRoute(h.context, data.canonicalLocation, "chat", new AbortController().signal),
    ).resolves.toMatchObject({ kind: "session", sessionKey: sessionRouteKey });
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.resolve")).toHaveLength(
      1,
    );
  });

  it.each([
    { name: "missing", reply: { ok: false }, kind: "missing-session" },
    {
      name: "ambiguous",
      reply: { ok: false, candidates: [{ key: sessionRouteKey, agentId: "roboclaw" }] },
      kind: "ambiguous",
    },
  ] satisfies Array<{ name: string; reply: SessionsResolveResult; kind: string }>)(
    "preserves the $name result",
    async ({ reply, kind }) => {
      const h = fixture();
      const pending = loadChatRoute(h.context, location, "chat", h.controller.signal);
      await h.started();
      h.reply.resolve(reply);
      expect(await pending).toMatchObject({ kind });
    },
  );

  it.each(["client", "hello", "profile", "disconnect"] as const)(
    "retires resolution identity on %s replacement before it arrives",
    async (change) => {
      const h = fixture();
      const baseline = h.listenerCounts();
      let settled = false;
      const pending = loadChatRoute(h.context, location, "chat", h.controller.signal).then(
        (data) => {
          settled = true;
          return data;
        },
      );
      await h.started();
      const original = { ...h.context.gateway.snapshot };
      if (change === "client") {
        h.publishGateway({ client: null });
      } else if (change === "hello") {
        h.publishGateway({ hello: gatewayHelloForMethods(["sessions.resolve"]) });
      } else if (change === "profile") {
        h.publishGateway({ selfUser: { id: "other-reader" } });
      } else {
        h.publishGateway({ phase: "reconnecting" });
      }
      await Promise.resolve();
      expect(settled).toBe(false);
      h.publishGateway(original);
      h.reply.resolve(resolved);
      const data = await pending;
      expect(h.listenerCounts()).toEqual(baseline);
      if (!("kind" in data) || data.kind !== "session" || !data.canonicalLocation) {
        throw new Error("Expected a canonical session location");
      }
      await expect(
        loadChatRoute(h.context, data.canonicalLocation, "chat", new AbortController().signal),
      ).resolves.toMatchObject({ kind: "session", sessionKey: sessionRouteKey });
      expect(h.request.mock.calls.filter(([method]) => method === "sessions.resolve")).toHaveLength(
        2,
      );
    },
  );

  it.each(["navigation", "application"] as const)("cleans up when %s is aborted", async (owner) => {
    const h = fixture();
    const baseline = h.listenerCounts();
    const pending = loadChatRoute(h.context, location, "chat", h.controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await h.started();
    if (owner === "navigation") {
      h.controller.abort();
    } else {
      h.stop();
    }
    await rejected;
    expect(h.listenerCounts()).toEqual(baseline);
    h.reply.resolve(resolved);
  });
});
