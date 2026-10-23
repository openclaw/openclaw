import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveInFlightRunSnapshot } from "../chat-inflight-snapshot.runtime.js";
import { createChatRunState } from "../server-chat-state.js";
import { resolveEmbeddedAgentRunRecoverySnapshot } from "./chat-history-recovery.js";
import { registerActiveRpcSourceForTest } from "./rpc-source-fixtures.test-support.js";
import type { GatewayContextResolver } from "./types.js";

it.each(["native", "rpc"] as const)(
  "%s history adopts its logical store through prepared physical scope and keeps Gateway isolation",
  async (kind) => {
    const localGateway: GatewayContextResolver = () => undefined;
    const otherGateway: GatewayContextResolver = () => undefined;
    const sessionKey = "agent:main:history-scope";
    const sessionId = "history-scope-session";
    const physicalStore = "/synthetic/history-scope/local.sqlite";
    const paths = new Map([
      ["/synthetic/history-scope/local.json", physicalStore],
      ["/synthetic/history-scope/other-gateway.json", physicalStore],
      ["/synthetic/history-scope/foreign.json", "/synthetic/history-scope/foreign.sqlite"],
    ]);
    const handles: EmbeddedAgentQueueHandle[] = [];
    const chatRunState = createChatRunState();
    const register = async (name: string, gateway: GatewayContextResolver) => {
      const runId = name === "local" ? `${kind}-local` : `${kind}-z-${name}`;
      const source = await withPluginRuntimeGatewayContextResolver(gateway, () =>
        registerActiveRpcSourceForTest(
          runId,
          { controlUiVisible: kind !== "native" },
          {
            sessionKey,
            sessionId,
            agentId: "main",
            storeScope: `/synthetic/history-scope/${name}.json`,
          },
        ),
      );
      chatRunState.getOrCreate(runId).buffer = `${name} partial`;
      if (kind === "native") {
        const handle: EmbeddedAgentQueueHandle = {
          runId,
          startedAtMs: 1_700_000_000_000,
          abort: vi.fn(),
          isAborted: () => false,
          isCompacting: () => false,
          isStreaming: () => true,
          queueMessage: async () => undefined,
        };
        handles.push(handle);
        attachActiveEmbeddedRun(
          sessionId,
          handle,
          sessionKey,
          undefined,
          "main",
          expectDefined(source.input.claim?.operation, "admitted native turn"),
        );
      }
    };
    try {
      await register("local", localGateway);
      await register("foreign", localGateway);
      await register("other-gateway", otherGateway);
      const params = {
        storePath: physicalStore,
        physicalPaths: (locator: string) => [paths.get(locator) ?? locator],
        resolveGatewayContext: localGateway,
        chatRunState,
        requestedSessionKey: sessionKey,
        canonicalSessionKey: sessionKey,
        sessionId,
        agentId: "main",
        defaultAgentId: "main",
      };
      const resolve =
        kind === "native" ? resolveEmbeddedAgentRunRecoverySnapshot : resolveInFlightRunSnapshot;
      expect(resolve(params)).toMatchObject({
        runId: `${kind}-local`,
        text: "local partial",
        ...(kind === "native" ? { sessionAbortable: true } : {}),
      });
      expect(resolve({ ...params, physicalPaths: undefined })).toBeUndefined();
      expect(resolve({ ...params, resolveGatewayContext: undefined })).toBeUndefined();
      expect(
        resolve({ ...params, storePath: "/synthetic/history-scope/missing.sqlite" }),
      ).toBeUndefined();
    } finally {
      for (const handle of handles) {
        detachActiveEmbeddedRun(sessionId, handle);
      }
    }
  },
);
