import "./dispatch-from-config.base.test-utils.js";
import "./dispatch-from-config.routing.test-utils.js";
import "./dispatch-from-config.media-ownership.test-utils.js";
import "./dispatch-from-config.progress.test-utils.js";
import "./dispatch-from-config.visibility.test-utils.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  runtimePluginMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { getPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import { buildTestCtx } from "./test-ctx.js";

describe("dispatchReplyFromConfig", () => {
  beforeEach(describe0BeforeEach0);

  it("keeps a raw three-argument resolver on one prepared generation across replacement", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    let receivedPreparedRuntime: unknown;
    let replacementPreparedRuntime: unknown;
    const preparedRegistry = createTestRegistry([]);
    const preparedRuntimeModule = await import("../../agents/prepared-model-runtime.js");
    const preparedRuntime = Object.freeze({
      agentId: "main",
      agentDir: "/tmp/prepared-agent",
      workspaceDir: "/tmp/prepared-workspace",
      config: cfg,
      modelCatalog: { entries: [], routeVariants: [] },
      inboundPluginRegistry: preparedRegistry,
      pluginGeneration: {} as never,
    });
    const preparedLookup = vi
      .spyOn(preparedRuntimeModule, "loadPublishedGatewayReplyDispatchRuntime")
      .mockResolvedValueOnce(preparedRuntime)
      .mockResolvedValue(
        Object.freeze({
          ...preparedRuntime,
          workspaceDir: "/tmp/replacement-workspace",
        }),
      );
    const replyResolver = vi.fn(
      async (_ctx: MsgContext, _opts?: GetReplyOptions, configOverride?: OpenClawConfig) => {
        expect(configOverride).toBeUndefined();
        receivedPreparedRuntime = getPreparedReplyDispatchRuntime();
        replacementPreparedRuntime = await preparedLookup({ agentId: "main" });
        expect(getPreparedReplyDispatchRuntime()).toBe(receivedPreparedRuntime);
        return { text: "hi" } satisfies ReplyPayload;
      },
    );
    try {
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          SessionKey: "agent:main:main",
          MessageSid: "prepared",
        }),
        cfg,
        dispatcher: createDispatcher(),
        replyResolver,
      });
      expect(preparedLookup).toHaveBeenCalledTimes(2);
      expect(preparedLookup).toHaveBeenNthCalledWith(1, {
        agentId: "main",
        demand: "interactive",
        onRuntimeLease: expect.any(Function),
      });
      expect(preparedLookup).toHaveBeenNthCalledWith(2, { agentId: "main" });
      expect(runtimePluginMocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
      expect(receivedPreparedRuntime).toBe(preparedRuntime);
      expect(replacementPreparedRuntime).not.toBe(preparedRuntime);
    } finally {
      preparedLookup.mockRestore();
    }
  });
});
