import { beforeEach, describe, expect, it } from "vitest";
import { createCronTool } from "./cron-tool.js";
import { callGatewayMock, resetCronToolGatewayMock } from "./cron-tool.test-helpers.js";

describe("cron tool flat-params", () => {
  beforeEach(() => {
    resetCronToolGatewayMock();
  });

  it("preserves explicit top-level sessionKey during flat-params recovery", async () => {
    const tool = createCronTool({ agentSessionKey: "agent:main:discord:channel:ops" });
    await tool.execute("call-flat-session-key", {
      action: "add",
      sessionKey: "agent:main:telegram:group:-100123:topic:99",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      message: "do stuff",
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: { sessionKey?: string };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.sessionKey).toBe("agent:main:telegram:group:-100123:topic:99");
  });
});
