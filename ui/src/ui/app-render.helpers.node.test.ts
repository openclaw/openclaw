// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveDashboardHeaderContext } from "./app-render.helpers.ts";

describe("resolveDashboardHeaderContext", () => {
  it("uses the active agent identity name", () => {
    expect(
      resolveDashboardHeaderContext({
        sessionKey: "agent:deep-chat:imessage:sample-thread",
        agentsList: {
          defaultId: "deep-chat",
          mainKey: "main",
          scope: "user",
          agents: [{ id: "deep-chat", identity: { name: "Deep Chat" } }],
        },
      }),
    ).toEqual({ agentLabel: "Deep Chat" });
  });

  it("falls back to the configured agent name", () => {
    expect(
      resolveDashboardHeaderContext({
        sessionKey: "agent:beta:main",
        agentsList: {
          defaultId: "beta",
          mainKey: "main",
          scope: "user",
          agents: [{ id: "beta", name: "Coding" }],
        },
      }),
    ).toEqual({ agentLabel: "Coding" });
  });

  it("falls back to the agent id", () => {
    expect(
      resolveDashboardHeaderContext({
        sessionKey: "agent:beta:subagent:maintainer-v2",
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "user",
          agents: [],
        },
      }),
    ).toEqual({ agentLabel: "beta" });
  });
});
