import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";

function loopbackParams(cfg: OpenClawConfig) {
  return {
    cfg,
    sessionKey: "agent:main:telegram:group:-100123",
    messageProvider: "telegram",
    currentChannelId: undefined,
    currentThreadTs: undefined,
    currentMessageId: undefined,
    currentInboundAudio: undefined,
    accountId: undefined,
    inboundEventKind: "user_request" as const,
    sourceReplyDeliveryMode: undefined,
    senderIsOwner: undefined,
  };
}

describe("resolveMcpLoopbackScopedTools — continuation exclusion", () => {
  it("excludes continue_work + request_compaction from the loopback (internal session-elected primitives, not external/CLI-invocable)", () => {
    const result = resolveMcpLoopbackScopedTools(
      loopbackParams({
        agents: { defaults: { continuation: { enabled: true } } },
      } as OpenClawConfig),
    );

    const names = result.tools.map((tool) => tool.name);
    expect(names).not.toContain("continue_work");
    expect(names).not.toContain("request_compaction");
  });

  it("still exposes continue_delegate on the loopback (dispatch primitive, not excluded)", () => {
    const result = resolveMcpLoopbackScopedTools(
      loopbackParams({
        agents: { defaults: { continuation: { enabled: true } } },
      } as OpenClawConfig),
    );

    expect(result.tools.map((tool) => tool.name)).toContain("continue_delegate");
  });
});
