import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import { createAgentToAgentPolicy, resolveSessionToolAccess } from "./sessions-access.js";
import { resolveSessionToolContext } from "./sessions-helpers.js";
import { prepareSessionsSendTarget } from "./sessions-send-target.js";

const requesterSessionKey = "agent:main:main";
const targetSessionKey = "agent:peer:subagent:known-child";
it.each([
  { visibility: "all", enabled: false, allow: undefined },
  { visibility: "agent", enabled: true, allow: undefined },
  { visibility: "all", enabled: true, allow: ["main"] },
] as const)(
  "denies unauthorized foreign label discovery before lookup ($visibility/$enabled)",
  async ({ visibility, enabled, allow }) => {
    const config: OpenClawConfig = {
      tools: {
        sessions: { visibility },
        agentToAgent: { enabled, ...(allow ? { allow: [...allow] } : {}) },
      },
    };
    const callGateway = vi.fn().mockResolvedValue({ key: targetSessionKey, agentId: "peer" });
    const result = await prepareSessionsSendTarget({
      toolContext: resolveSessionToolContext({ config, agentSessionKey: requesterSessionKey }),
      requesterAgentId: "main",
      toolParams: { agentId: "peer", label: "private label" },
      callGateway,
    });
    expect(result.ok).toBe(false);
    expect(callGateway).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(targetSessionKey);
  },
);

it("conceals a resolved label key when target visibility rejects it", async () => {
  const config: OpenClawConfig = {
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
  };
  const hiddenKey = "agent:peer:dashboard:incognito-hidden";
  const callGateway = vi.fn().mockResolvedValue({ key: hiddenKey, agentId: "peer" });
  const result = await prepareSessionsSendTarget({
    toolContext: resolveSessionToolContext({ config, agentSessionKey: requesterSessionKey }),
    requesterAgentId: "main",
    toolParams: { agentId: "peer", label: "private label" },
    callGateway,
  });
  expect(callGateway).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ ok: false, result: { details: { status: "forbidden" } } });
  expect(JSON.stringify(result)).not.toContain(hiddenKey);
});

it("a known exact child or scoped grant remains usable but does not authorize discovering its label", async () => {
  const config: OpenClawConfig = {
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: false } },
  };
  const callGateway = vi.fn().mockResolvedValue({ key: targetSessionKey, agentId: "peer" });
  const context = resolveSessionToolContext({ config, agentSessionKey: requesterSessionKey });
  const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) =>
    request.targetSessionKey === targetSessionKey ? { expectedSessionId: "known" } : undefined,
  );
  try {
    const hidden = await prepareSessionsSendTarget({
      toolContext: context,
      requesterAgentId: "main",
      toolParams: { agentId: "peer", label: "private label" },
      callGateway,
    });
    expect(hidden.ok).toBe(false);
    expect(callGateway).not.toHaveBeenCalled();
    const exact = await prepareSessionsSendTarget({
      toolContext: context,
      requesterAgentId: "main",
      toolParams: { sessionKey: targetSessionKey },
      callGateway,
    });
    expect(exact.ok).toBe(true);
    await expect(
      resolveSessionToolAccess({
        action: "send",
        requesterAgentId: "main",
        requesterSessionKey,
        targetAgentId: "peer",
        targetSessionKey,
        requesterOwned: false,
        visibility: "all",
        a2aPolicy: createAgentToAgentPolicy(config),
        callGateway,
      }),
    ).resolves.toMatchObject({ allowed: true, basis: "scoped-grant", expectedSessionId: "known" });
  } finally {
    unregister();
  }
  await expect(
    resolveSessionToolAccess({
      action: "send",
      requesterAgentId: "main",
      requesterSessionKey,
      targetAgentId: "peer",
      targetSessionKey,
      requesterOwned: true,
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy(config),
      callGateway,
    }),
  ).resolves.toMatchObject({ allowed: true });
});
