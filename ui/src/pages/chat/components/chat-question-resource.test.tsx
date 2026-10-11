/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import type { ApplicationContext } from "../../../app/context-types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatQuestionResource } from "./chat-question-resource.tsx";

it("keeps the Solid application context when opening a resource preview", async () => {
  const request = createGatewayRequestMock(async (method) => {
    if (method === "mcp.app.formResource") {
      return { preview: { viewId: "preview-view" } };
    }
    if (method === "mcp.app.view") {
      throw new Error("Preview unavailable");
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const application = createApplicationGateway();
  application.publish({
    ...application.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
  });
  // SAFETY: This failure path consumes only the Gateway capability, before iframe setup.
  const context = { gateway: application.gateway } as ApplicationContext;
  const view = mountSolid(
    () => (
      <ChatQuestionResource
        question={{
          questionId: "part",
          header: "Part",
          question: "Choose a part",
          options: [
            {
              label: "Bracket",
              preview: { type: "resource_link", name: "Bracket", uri: "parts://bracket" },
            },
          ],
          resource: { viewId: "form-view", selection: "explicit" },
        }}
        requestId="question-request"
        sessionKey="agent:main:preview-session"
        agentId="main"
        selected={new Set()}
        disabled={false}
      />
    ),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );

  const previewButton = await waitForSolid(() =>
    view.getByRole("button", { name: "Preview resource: Bracket" }),
  );
  previewButton.click();

  await waitForSolid(() =>
    expect(view.container.querySelector("mcp-app-view .error")?.textContent).toContain(
      "Preview unavailable",
    ),
  );
  expect(request).toHaveBeenCalledWith(
    "mcp.app.formResource",
    {
      sessionKey: "agent:main:preview-session",
      agentId: "main",
      viewId: "form-view",
      requestId: "question-request",
      questionId: "part",
      action: "preview",
      optionIndex: 0,
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(request).toHaveBeenCalledWith(
    "mcp.app.view",
    { sessionKey: "agent:main:preview-session", viewId: "preview-view" },
    { signal: expect.any(AbortSignal) },
  );
});
