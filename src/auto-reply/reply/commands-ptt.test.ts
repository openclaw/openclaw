import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext, handleCommands } from "./commands.js";
import { parseInlineDirectives } from "./directive-handling.js";

const callGateway = vi.fn(async (_opts: { method?: string }) => ({ ok: true }));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts as { method?: string }),
  randomIdempotencyKey: () => "idem-test",
}));

function buildParams(commandBody: string, cfg: OpenClawConfig, ctxOverrides?: Partial<MsgContext>) {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "telegram",
    Surface: "telegram",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim().toLowerCase(),
    commandAuthorized: true,
  });

  return {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "telegram",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("handleCommands /ptt", () => {
  it("invokes talk.ptt.once on the default iOS node", async () => {
    callGateway.mockImplementation(async (opts: { method?: string; params?: unknown }) => {
      if (opts.method === "node.list") {
        return {
          nodes: [
            {
              nodeId: "ios-1",
              displayName: "iPhone",
              platform: "ios",
              connected: true,
            },
          ],
        };
      }
      if (opts.method === "node.invoke") {
        return {
          ok: true,
          nodeId: "ios-1",
          command: "talk.ptt.once",
          payload: { status: "offline" },
        };
      }
      return { ok: true };
    });

    const cfg = {
      commands: { text: true },
      channels: { telegram: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/ptt once", cfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("PTT once");
    expect(result.reply?.text).toContain("status: offline");

    const invokeCall = callGateway.mock.calls.find((call) => call[0]?.method === "node.invoke");
    expect(invokeCall).toBeTruthy();
    expect(invokeCall?.[0]?.params?.command).toBe("talk.ptt.once");
    expect(invokeCall?.[0]?.params?.idempotencyKey).toBe("idem-test");
  });
});
