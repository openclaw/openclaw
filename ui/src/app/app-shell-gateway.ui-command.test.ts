/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createProfileAppearanceGateway } from "./app-shell-gateway.test-support.ts";

it("opens the current agent GitHub identity panel without exposing authorization data", () => {
  const { context, owner } = createProfileAppearanceGateway(null);
  const navigate = vi.fn();
  Object.assign(context, { basePath: "", navigate });

  owner.handleGatewayEvent({
    type: "event",
    event: "ui.command",
    payload: {
      command: { kind: "agent-github-settings" },
      agentId: "release",
    },
  });

  expect(navigate).toHaveBeenCalledWith("agents", {
    pathname: "/settings/agents/release/tools",
  });
});
