import { describe, expect, it } from "vitest";
import { resolveDiscordNativeCommandSessionTargets } from "./native-command-session-targets.js";

describe("resolveDiscordNativeCommandSessionTargets", () => {
  it("uses the bound session for both targets when present", () => {
    expect(
      resolveDiscordNativeCommandSessionTargets({
        boundSessionKey: "agent:codex:acp:binding:discord:default:seed",
        effectiveRoute: {
          agentId: "codex",
          sessionKey: "agent:codex:discord:channel:chan-1",
        },
        sessionPrefix: "discord:slash",
        userId: "user-1",
      }),
    ).toEqual({
      sessionKey: "agent:codex:acp:binding:discord:default:seed",
      commandTargetSessionKey: "agent:codex:acp:binding:discord:default:seed",
    });
  });

  it("falls back to the routed slash and command target session keys", () => {
    expect(
      resolveDiscordNativeCommandSessionTargets({
        effectiveRoute: {
          agentId: "qwen",
          sessionKey: "agent:qwen:discord:channel:chan-1",
        },
        sessionPrefix: "discord:slash",
        userId: "user-1",
      }),
    ).toEqual({
      sessionKey: "agent:qwen:discord:slash:user-1",
      commandTargetSessionKey: "agent:qwen:discord:channel:chan-1",
    });
  });
});
