/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context-types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatQuestionResource } from "./chat-question-resource.tsx";
// Load before the timed interaction: this regression covers context, not cold module transforms.
import "../../../components/mcp-app-view-registration.ts";

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

it("publishes uploaded resource selections through its host and follows controlled selections", async () => {
  const request = createGatewayRequestMock(async (method) => {
    if (method === "mcp.app.formResource") {
      return { resources: [{ uri: "parts://notes", name: "notes.txt" }] };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const application = createApplicationGateway();
  application.publish({
    ...application.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
    hello: {
      ...gatewayHelloForMethods(["mcp.app.formResource"]),
      policy: { attachments: { maxBytes: 1024, maxImageBytes: 1024 }, maxPayload: 1024 * 1024 },
    },
  });
  // SAFETY: Resource uploads consume the Gateway and optional upload policy only.
  const context = { gateway: application.gateway } as ApplicationContext;
  const selections = vi.fn();
  const bubbled = vi.fn();
  const view = mountSolid(
    () => {
      const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
      return (
        <div onResource-selection={bubbled}>
          <ChatQuestionResource
            question={{
              questionId: "part",
              header: "Part",
              question: "Upload a part",
              options: [],
              resource: {
                viewId: "form-view",
                selection: "explicit",
                userOptions: { kind: "file" },
              },
            }}
            requestId="question-request"
            sessionKey="agent:main:upload-session"
            selected={selected()}
            disabled={false}
            onResource-selection={(event) => {
              selections(event.detail.values);
              setSelected(new Set(event.detail.values));
            }}
          />
        </div>
      );
    },
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  const input = await waitForSolid(() => view.getByLabelText<HTMLInputElement>("Part"));
  const file = new File(["example"], "notes.txt", { type: "text/plain" });
  file.arrayBuffer = async () => new TextEncoder().encode("example").buffer;
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));

  await waitForSolid(() => expect(selections).toHaveBeenCalledWith(["parts://notes"]));
  expect(request).toHaveBeenCalledWith(
    "mcp.app.formResource",
    {
      sessionKey: "agent:main:upload-session",
      agentId: undefined,
      viewId: "form-view",
      requestId: "question-request",
      questionId: "part",
      action: "upload",
      files: [{ name: "notes.txt", mimeType: "text/plain", content: "ZXhhbXBsZQ==" }],
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(bubbled).toHaveBeenCalledTimes(1);
  expect(bubbled.mock.calls[0]?.[0].target?.tagName).toBe("OPENCLAW-CHAT-QUESTION-RESOURCE");
  const remove = await waitForSolid(() => view.getByRole("button", { name: "Remove" }));
  remove.click();
  await waitForSolid(() => expect(view.queryByText("notes.txt")).toBeNull());
  expect(selections).toHaveBeenLastCalledWith([]);
  expect(bubbled).toHaveBeenCalledTimes(2);
});
