/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { AgentIdentityResult, AgentsListResult } from "../api/types.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

it.each([
  { agentId: "writer", rosterPresent: true },
  { agentId: "", rosterPresent: false },
])(
  "hydrates and updates the host avatar for $agentId (roster present: $rosterPresent)",
  async ({ agentId, rosterPresent }) => {
    const rosterAvatar = "data:image/png;base64,cm9zdGVy";
    const identityAvatar = "data:image/png;base64,aWRlbnRpdHk=";
    let identity: AgentIdentityResult = {
      agentId: "writer",
      name: "Writer",
      avatar: identityAvatar,
    };
    const roster: AgentsListResult = {
      defaultId: "writer",
      mainKey: "main",
      scope: "per-sender",
      agents: rosterPresent
        ? [{ id: "writer", name: "Writer", identity: { avatarUrl: rosterAvatar } }]
        : [],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "agent.identity.get") {
        return identity;
      }
      if (method === "agents.list") {
        return roster;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const gateway = createGateway(createTestGatewayClient(request));
    const sessions = createSessions("writer", []);
    const agentIdentity = createAgentIdentityCapability(gateway);
    const context = createContext(gateway, sessions, roster, [], agentIdentity);
    const lifetime = new AbortController();
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const components = createControlUiComponents({
      current: () => context,
      signal: lifetime.signal,
      onError,
    });
    const handle = components.mountAgentAvatar(container, { agentId, label: "Writer" });
    onTestFinished(() => {
      lifetime.abort();
      container.remove();
    });

    await vi.waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(identityAvatar);
    });

    identity = { agentId: "writer", name: "Writer", avatar: "data:image/png;base64,bmV3" };
    agentIdentity.invalidate(["writer"]);
    await vi.waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(identity.avatar);
    });

    handle.dispose();
    const requestCount = request.mock.calls.length;
    agentIdentity.invalidate(["writer"]);
    await Promise.resolve();
    expect(container.childElementCount).toBe(0);
    expect(request.mock.calls).toHaveLength(requestCount);
    expect(onError).not.toHaveBeenCalled();
  },
);
