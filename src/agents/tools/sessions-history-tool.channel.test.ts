import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requestContext } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "../../gateway/session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../../gateway/session-row-projection.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import type { CallGatewayRequest } from "./sessions-history-tool.test-support.js";

describe("sessions_history channel disclosure", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["retained", "route-withdrawn", "policy-withdrawn"] as const)(
    "consumes history only while its live channel authorization remains valid (%s)",
    async (mode) => {
      const requester = "agent:main:slack:channel:c111:thread:200.001";
      const target = "agent:main:slack:channel:c111:thread:200.002";
      const storePath = path.join(tempDirs.make("history-channel-disclosure-"), "sessions.json");
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        tools: { sessions: { visibility: "channel" } },
      };
      const entry = (sessionId: string, to = "channel:c111"): SessionEntry => ({
        sessionId,
        updatedAt: 1,
        chatType: "channel",
        space: "t111",
        delivery: {
          kind: "external",
          route: { channel: "slack", accountId: "default", target: { to, chatType: "channel" } },
          context: { channel: "slack", accountId: "default", to },
          origin: { provider: "slack", chatType: "channel" },
        },
      });
      const entries = { [requester]: entry("requester"), [target]: entry("target") };
      for (const [sessionKey, sessionEntry] of Object.entries(entries)) {
        replaceSessionEntrySync({ storePath, sessionKey }, sessionEntry);
      }
      const projection = createSessionRowProjectionFixture({ cfg, storePath, store: entries });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const entered = createDeferred();
      const response = createDeferred<{ messages: Array<{ role: string; content: string }> }>();
      const tool = createSessionsHistoryTool({
        config: cfg,
        agentSessionKey: requester,
        callGateway: async <T = Record<string, unknown>>(
          request: CallGatewayRequest,
        ): Promise<T> => {
          if (request.method === "sessions.resolve") {
            return { key: target } as T;
          }
          if (request.method === "sessions.describe") {
            const key = (request.params as { key: string }).key;
            const current = projection.describe({ agentId: "main", key });
            return {
              session: current && {
                key,
                agentId: "main",
                sessionId: current.entry.sessionId,
                chatType: current.entry.chatType,
                space: current.entry.space,
                origin: sessionDeliveryOrigin(current.entry),
                deliveryContext: deliveryContextFromSession(current.entry),
              },
            } as T;
          }
          expect(request.method).toBe("chat.history");
          entered.resolve();
          return (await response.promise) as T;
        },
      });
      const pending = withPluginRuntimeGatewayRequestScope(
        { context, isWebchatConnect: () => false },
        () => tool.execute("history-channel-disclosure", { sessionKey: target }),
      );
      await awaitGateBeforeSettlement(entered.promise, pending, "history read was not admitted");
      if (mode === "route-withdrawn") {
        const reassigned = entry("target", "channel:c222");
        replaceSessionEntrySync({ storePath, sessionKey: target }, reassigned);
        projection.setEntry(target, reassigned);
      } else if (mode === "policy-withdrawn") {
        cfg.tools = { sessions: { visibility: "self" } };
      }
      response.resolve({ messages: [{ role: "user", content: "BUFFERED HISTORY SECRET" }] });
      const result = await pending;

      if (mode !== "retained") {
        expect(result.details).toMatchObject({ status: "forbidden" });
        expect(JSON.stringify(result)).not.toContain("BUFFERED HISTORY SECRET");
      } else {
        expect(result.details).toMatchObject({
          sessionKey: target,
          messages: [{ role: "user", content: "BUFFERED HISTORY SECRET" }],
        });
      }
    },
  );

  it.each(["target", "archived-target"] as const)(
    "binds explicit history anchors to the admitted channel incarnation (%s)",
    async (requestedSessionId) => {
      const requester = "agent:main:slack:channel:c111:thread:201.001";
      const target = "agent:main:slack:channel:c111:thread:201.002";
      const storePath = path.join(tempDirs.make("history-channel-anchor-"), "sessions.json");
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        tools: { sessions: { visibility: "channel" } },
      };
      const delivery = {
        kind: "external",
        route: {
          channel: "slack",
          accountId: "default",
          target: { to: "channel:c111", chatType: "channel" },
        },
        context: { channel: "slack", accountId: "default", to: "channel:c111" },
        origin: { provider: "slack", chatType: "channel" },
      } as const;
      const entries: Record<string, SessionEntry> = {
        [requester]: {
          sessionId: "requester",
          updatedAt: 1,
          chatType: "channel",
          space: "t111",
          delivery,
        },
        [target]: {
          sessionId: "target",
          updatedAt: 1,
          chatType: "channel",
          space: "t111",
          delivery,
        },
      };
      for (const [sessionKey, sessionEntry] of Object.entries(entries)) {
        replaceSessionEntrySync({ storePath, sessionKey }, sessionEntry);
      }
      const projection = createSessionRowProjectionFixture({ cfg, storePath, store: entries });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const currentMessage = {
        role: "user",
        content: "current channel context",
        __openclaw: { id: "anchor-message", seq: 1 },
      };
      const archivedMessage = {
        role: "user",
        content: "ARCHIVED OTHER ACCOUNT SECRET",
        __openclaw: { id: "anchor-message", seq: 1 },
      };
      const tool = createSessionsHistoryTool({
        config: cfg,
        agentSessionKey: requester,
        callGateway: async <T = Record<string, unknown>>(
          request: CallGatewayRequest,
        ): Promise<T> => {
          if (request.method === "sessions.resolve") {
            return { key: target } as T;
          }
          if (request.method === "sessions.describe") {
            const key = (request.params as { key: string }).key;
            const current = projection.describe({ agentId: "main", key });
            return {
              session: current && {
                key,
                agentId: "main",
                sessionId: current.entry.sessionId,
                chatType: current.entry.chatType,
                space: current.entry.space,
                origin: sessionDeliveryOrigin(current.entry),
                deliveryContext: deliveryContextFromSession(current.entry),
              },
            } as T;
          }
          expect(request.method).toBe("chat.history");
          // The Gateway can reopen a retained anchor from a prior incarnation of this key.
          const { sessionId } = request.params as { sessionId: string };
          return {
            messages: [sessionId === "archived-target" ? archivedMessage : currentMessage],
          } as T;
        },
      });
      const result = await withPluginRuntimeGatewayRequestScope(
        { context, isWebchatConnect: () => false },
        () =>
          tool.execute("history-channel-anchor", {
            sessionKey: target,
            sessionId: requestedSessionId,
            messageId: "anchor-message",
          }),
      );

      if (requestedSessionId === "archived-target") {
        expect(result.details).toMatchObject({ status: "forbidden" });
        expect(JSON.stringify(result)).not.toContain("ARCHIVED OTHER ACCOUNT SECRET");
      } else {
        expect(result.details).toMatchObject({ sessionKey: target, messages: [currentMessage] });
      }
    },
  );
});
