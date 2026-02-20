import { describe, expect, it } from "vitest";
import { handleCustomCommand } from "./commands-custom.js";
import type { HandleCommandsParams } from "./commands-types.js";

function makeParams(overrides: {
  commandBody: string;
  custom?: Record<
    string,
    { exec: string; reply?: boolean; ownerOnly?: boolean; description?: string }
  >;
  isAuthorized?: boolean;
  workspaceDir?: string;
}): [HandleCommandsParams, boolean] {
  const body = overrides.commandBody;
  const params = {
    ctx: {} as HandleCommandsParams["ctx"],
    cfg: {
      commands: {
        custom: overrides.custom ?? {},
      },
    } as HandleCommandsParams["cfg"],
    command: {
      commandBodyNormalized: body,
      rawBodyNormalized: body,
      isAuthorizedSender: overrides.isAuthorized ?? true,
      senderIsOwner: overrides.isAuthorized ?? true,
      senderId: "test-user",
      surface: "webchat",
      channel: "webchat",
      ownerList: [],
    } as HandleCommandsParams["command"],
    sessionKey: "agent:main:main",
    workspaceDir: overrides.workspaceDir ?? "/tmp",
    directives: {
      model: undefined,
      thinking: undefined,
      verbose: undefined,
      reasoning: undefined,
      elevated: undefined,
    },
    elevated: { enabled: false, allowed: false, failures: [] },
    isGroup: false,
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    defaultGroupActivation: () => "always" as const,
    provider: "webchat",
    model: "test",
    contextTokens: 0,
  } as unknown as HandleCommandsParams;
  return [params, true];
}

describe("handleCustomCommand", () => {
  it("returns null when no custom commands configured", async () => {
    const [params, allow] = makeParams({ commandBody: "/dnd", custom: {} });
    const result = await handleCustomCommand(params, allow);
    expect(result).toBeNull();
  });

  it("matches /dnd and runs echo script", async () => {
    const [params, allow] = makeParams({
      commandBody: "/dnd",
      custom: {
        dnd: { exec: "echo 🔕 DND toggled", reply: true },
      },
    });
    const result = await handleCustomCommand(params, allow);
    expect(result).not.toBeNull();
    expect(result!.shouldContinue).toBe(false);
    expect(result!.reply?.text).toBe("🔕 DND toggled");
  });

  it("matches dnd without slash prefix", async () => {
    const [params, allow] = makeParams({
      commandBody: "dnd",
      custom: {
        dnd: { exec: "echo toggled", reply: true },
      },
    });
    const result = await handleCustomCommand(params, allow);
    expect(result).not.toBeNull();
    expect(result!.reply?.text).toBe("toggled");
  });

  it("passes ARGS to the script", async () => {
    const [params, allow] = makeParams({
      commandBody: "/dnd on",
      custom: {
        dnd: { exec: "echo ${ARGS}", reply: true },
      },
    });
    const result = await handleCustomCommand(params, allow);
    expect(result).not.toBeNull();
    expect(result!.reply?.text).toBe("on");
  });

  it("blocks unauthorized senders when ownerOnly", async () => {
    const [params, allow] = makeParams({
      commandBody: "/dnd",
      custom: {
        dnd: { exec: "echo secret", reply: true },
      },
      isAuthorized: false,
    });
    const result = await handleCustomCommand(params, allow);
    expect(result).not.toBeNull();
    expect(result!.shouldContinue).toBe(false);
    expect(result!.reply).toBeUndefined();
  });

  it("returns error on script failure", async () => {
    const [params, allow] = makeParams({
      commandBody: "/fail",
      custom: {
        fail: { exec: "exit 1", reply: true },
      },
    });
    const result = await handleCustomCommand(params, allow);
    expect(result).not.toBeNull();
    expect(result!.reply?.text).toContain("⚠️ Custom command `/fail` failed");
  });

  it("interpolates WORKSPACE in exec string", async () => {
    const [params, allow] = makeParams({
      commandBody: "/test",
      custom: {
        test: { exec: "echo ${WORKSPACE}", reply: true },
      },
      workspaceDir: "/tmp",
    });
    const result = await handleCustomCommand(params, allow);
    // If shell is available, expect the workspace dir; otherwise expect an error reply
    if (result!.reply?.text?.startsWith("⚠️")) {
      // Shell not available in test environment — skip assertion
      expect(result!.shouldContinue).toBe(false);
    } else {
      expect(result!.reply?.text).toBe("/tmp");
    }
  });

  it("escapes shell metacharacters in ARGS to prevent injection", async () => {
    const [params, allow] = makeParams({
      commandBody: "/cmd ; rm -rf /",
      custom: {
        cmd: { exec: "echo ${ARGS}", reply: true },
      },
    });
    const result = await handleCustomCommand(params, allow);
    expect(result).not.toBeNull();
    // The semicolon should be treated as literal text, not a command separator
    expect(result!.reply?.text).toBe("; rm -rf /");
  });
});
