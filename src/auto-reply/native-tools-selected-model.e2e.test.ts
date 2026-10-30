import { describe, expect, it, vi } from "vitest";
import {
  getRunEmbeddedAgentMock,
  installTriggerHandlingReplyHarness,
  MAIN_SESSION_KEY,
  makeCfg,
  mockRunEmbeddedAgentOk,
  requireSessionStorePath,
  withTempHome,
} from "../../test/helpers/auto-reply/trigger-handling-test-harness.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { MsgContext } from "./templating.js";

type GetReplyFromConfig = typeof import("./reply/get-reply.js").getReplyFromConfig;
type ReplyAgentParams = Parameters<typeof import("./reply/agent-runner-run.js").runReplyAgent>[0];

// mock-isolation: Exercise command routing without starting a provider-backed agent runtime.
vi.mock("./reply/agent-runner-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply/agent-runner-run.js")>()),
  runReplyAgent: async ({ followupRun: { run } }: ReplyAgentParams) => {
    const result = await getRunEmbeddedAgentMock()({ ...run });
    return { text: result?.payloads?.[0]?.text };
  },
}));

let capturedGetReplyFromConfig: GetReplyFromConfig | undefined;
installTriggerHandlingReplyHarness((impl) => {
  capturedGetReplyFromConfig = impl;
});

function getReplyFromConfig(
  ...args: Parameters<GetReplyFromConfig>
): ReturnType<GetReplyFromConfig> {
  if (!capturedGetReplyFromConfig) {
    throw new Error("Expected trigger handling reply harness to install getReplyFromConfig");
  }
  return capturedGetReplyFromConfig(...args);
}

describe("native /tools selected-model inventory (#188285)", () => {
  it("applies the saved session runtime's Codex exclusion through the shipped entry point", async () => {
    await withTempHome(async (home) => {
      mockRunEmbeddedAgentOk();
      const cfg = makeCfg(home);
      const agentDefaults = cfg.agents?.defaults;
      if (!agentDefaults) {
        throw new Error("expected agent defaults in the harness config");
      }
      // The default model runs on the OpenClaw runtime; the saved session
      // selection runs on Codex, whose dynamic-tool policy excludes the
      // brokered GitHub tools.
      agentDefaults.model = { primary: "openai/gpt-4.1" };
      agentDefaults.models = {
        "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } },
        "openai/gpt-4.1-mini": { agentRuntime: { id: "codex" } },
      };
      cfg.plugins = {
        entries: {
          codex: {
            config: {
              codexDynamicToolsExclude: ["github_publish", "github_identity_status"],
            },
          },
        },
      };
      const storePath = requireSessionStorePath(cfg);
      await replaceSessionEntry(
        { storePath, sessionKey: MAIN_SESSION_KEY },
        {
          sessionId: "session-target",
          updatedAt: Date.now(),
          providerOverride: "openai",
          modelOverride: "gpt-4.1-mini",
          modelOverrideSource: "user",
        },
      );
      const message: MsgContext = {
        Body: "/tools",
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        From: "telegram:111",
        To: "telegram:111",
        SessionKey: "telegram:slash:188285",
        CommandSource: "native",
        CommandTargetSessionKey: MAIN_SESSION_KEY,
        CommandAuthorized: true,
      };
      // SAFETY: only the host's runtime identity is read off this stub; no Gateway method executes.
      const gateway = { localEmbedded: false } as unknown as GatewayRequestContext;
      const reply = await withPluginRuntimeGatewayContextResolver(
        () => gateway,
        () => getReplyFromConfig(message, {}, cfg),
      );
      const text = (Array.isArray(reply) ? reply[0]?.text : reply?.text) ?? "";

      expect(text).toContain("Available tools");
      expect(text).not.toContain("github_publish");
      expect(text).not.toContain("github_identity_status");
    });
  });
});
