import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from "../../../packages/gateway-protocol/src/schema/sessions-viewer-presence.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const sessionsListHandler = vi.hoisted(() =>
  vi.fn(async ({ respond }: GatewayRequestHandlerOptions) => {
    respond(true, { count: 1 }, undefined);
  }),
);

vi.mock("./sessions-read.js", () => ({ sessionsListHandler }));

import { callAgentHandler } from "./agents-mutate.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const subscribeSessionEvents = vi.fn();
beforeEach(() => vi.clearAllMocks());

function request(
  method: "sessions.viewers.set" | "sessions.subscribe",
  params: Record<string, unknown>,
  context: Partial<GatewayRequestContext> = { subscribeSessionEvents },
  connId: string | null = "control-ui-1",
) {
  const handler = expectDefined(sessionSubscriptionHandlers[method], method);
  return callAgentHandler(handler, method, params, {
    context: context as GatewayRequestContext,
    client: connId === null ? null : ({ connId } as never),
  });
}

function expectError(respond: ReturnType<typeof vi.fn>, code: string) {
  expectReply(respond, false, undefined, expect.objectContaining({ code }));
}
function expectReply(respond: ReturnType<typeof vi.fn>, ...args: unknown[]) {
  expect(respond).toHaveBeenCalledWith(...args);
}

function createContext(cfg?: OpenClawConfig) {
  const config = cfg ?? { agents: { entries: { work: {} } }, session: { mainKey: "home" } };
  const replace = vi.fn((_connId: string, sessionKeys: readonly string[]) =>
    [...new Set(sessionKeys)].toSorted(),
  );
  const context = {
    getRuntimeConfig: () => config,
    sessionViewerPresence: { replace },
  } as unknown as GatewayRequestContext;
  return {
    replace,
    declare: (body: Record<string, unknown>, connId = "conn-viewer") =>
      request("sessions.viewers.set", body, context, connId),
  };
}

describe("sessions.viewers.set", () => {
  it("canonicalizes and atomically replaces the connection set", async () => {
    const { declare, replace } = createContext();
    const respond = await declare(
      { sessionKeys: [" main ", "agent:work:other", "main"] },
      " conn-viewer ",
    );

    expect(replace.mock.calls[0]?.[0]).toBe("conn-viewer");
    expectReply(respond, true, { sessionKeys: ["agent:work:home", "agent:work:other"] }, undefined);
  });

  it("accepts an empty declaration and rejects malformed or oversized sets", async () => {
    const { declare, replace } = createContext();
    expectReply(await declare({ sessionKeys: [] }), true, { sessionKeys: [] }, undefined);

    expectError(await declare({ sessionKeys: [" "] }), "INVALID_REQUEST");

    const oversized = await declare({
      sessionKeys: Array.from(
        { length: SESSION_VIEWER_PRESENCE_MAX_KEYS + 1 },
        (_, index) => `session-${index}`,
      ),
    });
    expectError(oversized, "INVALID_REQUEST");
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("requires a live connection and declaration owner", async () => {
    expectError(
      await request("sessions.viewers.set", { sessionKeys: [] }, {}, null),
      "UNAVAILABLE",
    );
  });

  it("scopes bare viewer identities by explicit owner and rejects ambiguity", async () => {
    const { declare, replace } = createContext({
      agents: { ownership: "explicit", entries: { main: {}, work: {} } },
    });

    const selected = await declare({ sessionKeys: ["global"], agentId: "work" });
    expectReply(selected, true, { sessionKeys: ["agent:work:global"] }, undefined);

    replace.mockClear();
    const ambiguous = await declare({ sessionKeys: ["global"] });
    expect(replace).not.toHaveBeenCalled();
    expectError(ambiguous, "INVALID_REQUEST");
  });
});

describe("sessions.subscribe", () => {
  it("registers events before projecting an atomic bootstrap roster", async () => {
    const respond = await request("sessions.subscribe", { limit: 1, ownerFirst: true });

    expect(subscribeSessionEvents).toHaveBeenCalledWith("control-ui-1");
    expect(subscribeSessionEvents.mock.invocationCallOrder[0]).toBeLessThan(
      sessionsListHandler.mock.invocationCallOrder[0]!,
    );
    expectReply(respond, true, { subscribed: true, list: { count: 1 } }, undefined, undefined);
  });

  it("rejects invalid list params before registering events", async () => {
    const respond = await request("sessions.subscribe", {
      activityPulseBoundaries: [1, 1],
    });

    expect(subscribeSessionEvents).not.toHaveBeenCalled();
    expect(sessionsListHandler).not.toHaveBeenCalled();
    expectError(respond, "INVALID_REQUEST");
  });
});
