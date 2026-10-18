import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from "../../../packages/gateway-protocol/src/schema/sessions-viewer-presence.js";

const sessionsListHandler = vi.hoisted(() =>
  vi.fn(async ({ respond }: GatewayRequestHandlerOptions) => {
    respond(true, { count: 1 }, undefined);
  }),
);

vi.mock("./sessions-read.js", () => ({ sessionsListHandler }));

import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

async function request(
  method: "sessions.viewers.set" | "sessions.subscribe",
  params: Record<string, unknown>,
  context: GatewayRequestContext,
  connId?: string,
) {
  const respond = vi.fn();
  await expectDefined(
    sessionSubscriptionHandlers[method],
    method,
  )({
    req: { type: "req", id: "req-viewers", method, params },
    params,
    respond,
    context,
    client: connId === undefined ? null : ({ connId } as never),
    isWebchatConnect: () => false,
  } satisfies GatewayRequestHandlerOptions);
  return respond;
}

const declare = (body: Record<string, unknown>, context: GatewayRequestContext, connId?: string) =>
  request("sessions.viewers.set", body, context, connId);
function expectError(respond: ReturnType<typeof vi.fn>, code: string) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code }));
}

function createContext() {
  const replace = vi.fn((_connId: string, sessionKeys: readonly string[]) =>
    [...new Set(sessionKeys)].toSorted(),
  );
  const context = {
    getRuntimeConfig: () => ({
      agents: { entries: { work: {} } },
      session: { mainKey: "home" },
    }),
    sessionViewerPresence: { replace },
  } as unknown as GatewayRequestContext;
  return { context, replace };
}

describe("sessions.viewers.set", () => {
  it("canonicalizes and atomically replaces the connection set", async () => {
    const { context, replace } = createContext();
    const respond = await declare(
      { sessionKeys: [" main ", "agent:work:other", "main"] },
      context,
      " conn-viewer ",
    );

    expect(replace).toHaveBeenCalledWith("conn-viewer", [
      "agent:work:home",
      "agent:work:other",
      "agent:work:home",
    ]);
    expect(respond).toHaveBeenCalledWith(
      true,
      { sessionKeys: ["agent:work:home", "agent:work:other"] },
      undefined,
    );
  });

  it("accepts an empty declaration and rejects malformed or oversized sets", async () => {
    const { context, replace } = createContext();
    const empty = await declare({ sessionKeys: [] }, context, "conn-viewer");
    expect(empty).toHaveBeenCalledWith(true, { sessionKeys: [] }, undefined);

    expectError(await declare({ sessionKeys: [" "] }, context, "conn-viewer"), "INVALID_REQUEST");

    const oversized = await declare(
      {
        sessionKeys: Array.from(
          { length: SESSION_VIEWER_PRESENCE_MAX_KEYS + 1 },
          (_, index) => `session-${index}`,
        ),
      },
      context,
      "conn-viewer",
    );
    expectError(oversized, "INVALID_REQUEST");
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("requires a live connection and declaration owner", async () => {
    const context = { getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext;
    expectError(await declare({ sessionKeys: [] }, context), "UNAVAILABLE");
  });

  it("scopes bare viewer identities by explicit owner and rejects ambiguity", async () => {
    const replace = vi.fn((_connId: string, sessionKeys: readonly string[]) => sessionKeys);
    const context = {
      getRuntimeConfig: () => ({
        agents: { ownership: "explicit", entries: { main: {}, work: {} } },
      }),
      sessionViewerPresence: { replace },
    } as unknown as GatewayRequestContext;

    const selected = await declare(
      { sessionKeys: ["global"], agentId: "work" },
      context,
      "conn-viewer",
    );
    expect(replace).toHaveBeenCalledWith("conn-viewer", ["agent:work:global"]);
    expect(selected).toHaveBeenCalledWith(true, { sessionKeys: ["agent:work:global"] }, undefined);

    replace.mockClear();
    const ambiguous = await declare({ sessionKeys: ["global"] }, context, "conn-viewer");
    expect(replace).not.toHaveBeenCalled();
    expectError(ambiguous, "INVALID_REQUEST");
  });
});

describe("sessions.subscribe", () => {
  it("registers events before projecting an atomic bootstrap roster", async () => {
    const subscribeSessionEvents = vi.fn();
    const context = { subscribeSessionEvents } as unknown as GatewayRequestContext;
    sessionsListHandler.mockClear();
    const respond = await request(
      "sessions.subscribe",
      { limit: 1, ownerFirst: true },
      context,
      "control-ui-1",
    );

    expect(subscribeSessionEvents).toHaveBeenCalledWith("control-ui-1");
    expect(subscribeSessionEvents.mock.invocationCallOrder[0]).toBeLessThan(
      sessionsListHandler.mock.invocationCallOrder[0]!,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, list: { count: 1 } },
      undefined,
      undefined,
    );
  });

  it("rejects invalid list params before registering events", async () => {
    const subscribeSessionEvents = vi.fn();
    sessionsListHandler.mockClear();
    const respond = await request(
      "sessions.subscribe",
      { activityPulseBoundaries: [1, 1] },
      { subscribeSessionEvents } as unknown as GatewayRequestContext,
      "control-ui-1",
    );

    expect(subscribeSessionEvents).not.toHaveBeenCalled();
    expect(sessionsListHandler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("activityPulseBoundaries: must be strictly ascending"),
      }),
    );
  });
});
