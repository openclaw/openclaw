/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { openTemplateCreator } from "../pages/templates/creator-owner.ts";
import { createProfileAppearanceGateway } from "./app-shell-gateway.test-support.ts";

vi.mock("../pages/templates/creator-owner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pages/templates/creator-owner.ts")>()),
  openTemplateCreator: vi.fn(),
}));

it("drops a deferred review handoff after its application context retires", async () => {
  vi.mocked(openTemplateCreator).mockClear();
  const { host, owner } = createProfileAppearanceGateway(null);
  owner.handleGatewayEvent({
    type: "event",
    event: "ui.command",
    payload: {
      command: { kind: "template-review", draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087" },
      agentId: "research",
      sessionKey: "agent:research:dashboard:source",
    },
  });
  Object.defineProperty(host, "context", { value: undefined });
  await vi.dynamicImportSettled();
  expect(openTemplateCreator).not.toHaveBeenCalled();
});

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
