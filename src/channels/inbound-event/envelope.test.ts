import {
  createInboundEnvelopeBuilder,
  resolveInboundRouteEnvelopeBuilder,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
} from "openclaw/plugin-sdk/inbound-envelope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAgentEnvelope, resolveEnvelopeFormatOptions } from "../../auto-reply/envelope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimePluginScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveChannelInboundRouteEnvelope } from "./envelope.js";

const readSessionUpdatedAtCore = vi.hoisted(() => vi.fn(() => 60_000));
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/state/main/sessions.json"));
const resolveAgentRoute = vi.hoisted(() =>
  vi.fn(() => ({
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:peer",
    accountId: "default",
  })),
);

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: resolveStorePath,
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({ readSessionUpdatedAtCore }));
vi.mock("../../routing/resolve-route.js", () => ({ resolveAgentRoute }));

const cfg = {
  agents: { defaults: { userTimezone: "UTC" } },
  session: { store: "/state/{agentId}/sessions.json" },
} as OpenClawConfig;
const routeParams = {
  cfg,
  channel: "telegram",
  accountId: "default",
  peer: { kind: "direct" as const, id: "peer" },
};
const envelopeParams = {
  cfg,
  sessionStore: cfg.session?.store,
  resolveStorePath,
  readSessionUpdatedAt: readSessionUpdatedAtCore,
  resolveEnvelopeFormatOptions,
  formatAgentEnvelope,
};
const message = { channel: "Telegram", from: "Alice", body: "hello" };
const timedMessage = { ...message, timestamp: 120_000 };
const formattedMessage = "[Telegram Alice +1m Thu 1970-01-01T00:02:00Z] hello";
const sdkResult = { storePath: "/state/main/sessions.json", body: formattedMessage };

describe("channel inbound envelope", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("warns once with an awaited replacement while retaining the released envelope result", () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    withPluginRuntimePluginScope({ pluginId: "envelope-deprecation-consumer" }, () => {
      for (let i = 0; i < 2; i += 1) {
        const buildEnvelope = createInboundEnvelopeBuilder({
          ...envelopeParams,
          route: resolveAgentRoute(),
        });
        expect(buildEnvelope(timedMessage)).toEqual(sdkResult);
      }
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "createInboundEnvelopeBuilder is deprecated; use await createChannelInboundEnvelopeBuilderAsync",
      ),
      { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
    );
  });

  it.each(["routed", "runtime"] as const)(
    "preserves the shipped SDK resolveStorePath callback through the %s helper",
    (helper) => {
      const resolved =
        helper === "routed"
          ? resolveInboundRouteEnvelopeBuilder({
              ...envelopeParams,
              ...routeParams,
              resolveAgentRoute,
            })
          : resolveInboundRouteEnvelopeBuilderWithRuntime({
              ...routeParams,
              sessionStore: cfg.session?.store,
              runtime: {
                routing: { resolveAgentRoute },
                session: { resolveStorePath, readSessionUpdatedAt: readSessionUpdatedAtCore },
                reply: { resolveEnvelopeFormatOptions, formatAgentEnvelope },
              },
            });

      expect(resolved.route.sessionKey).toBe("agent:main:telegram:direct:peer");
      expect(resolved.buildEnvelope(timedMessage)).toEqual(sdkResult);
      expect(resolveStorePath).toHaveBeenCalledWith(cfg.session?.store, { agentId: "main" });
    },
  );

  it("binds routing, session lookup and formatting in one core operation", () => {
    const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope(routeParams);
    expect(route.sessionKey).toBe("agent:main:telegram:direct:peer");
    expect(buildEnvelope(message)).toBe("[Telegram Alice] hello");
    expect(buildEnvelope(timedMessage)).toBe(formattedMessage);
    readSessionUpdatedAtCore.mockClear();
    expect(
      buildEnvelope({ ...message, body: "older", timestamp: 30_000, previousTimestamp: null }),
    ).toBe("[Telegram Alice Thu 1970-01-01T00:00:30Z] older");
    expect(readSessionUpdatedAtCore).not.toHaveBeenCalled();
  });
});
