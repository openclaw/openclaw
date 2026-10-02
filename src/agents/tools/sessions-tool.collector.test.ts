import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { createSessionsTool } from "./sessions-tool.js";

it.each([false, true])(
  "withholds and rejects Stop when disabled by the host (sender is owner: %s)",
  async (senderIsOwner) => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      senderIsOwner,
      sessionControlAuthority: createAdmittedRunOperatorAuthority({
        profileId: "collector-requester",
        scopes: ["operator.write"],
        assertCurrent: () => {},
      }),
      stopAllowed: false,
      callGateway,
    });
    expect(tool.parameters).toMatchObject({
      properties: { action: { enum: expect.not.arrayContaining(["stop"]) } },
    });
    expect(tool.parameters).not.toHaveProperty("properties.runId");
    expect(tool.parameters).not.toHaveProperty("properties.clearQueued");
    expect(tool.parameters).toMatchObject({ properties: { archived: { type: "boolean" } } });
    await expect(
      tool.execute("collector-stop", {
        action: "stop",
        sessionKey: "agent:main:dashboard:target",
      }),
    ).rejects.toThrow(/unavailable to non-interactive collectors/);
    expect(callGateway).not.toHaveBeenCalled();
  },
);
