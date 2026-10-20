/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { QuestionResourceActionResult } from "../../../../../packages/gateway-protocol/src/question-resource.js";
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

it("publishes uploaded resource selections and follows controlled selections", async () => {
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
  let setDisabled!: (value: boolean) => void;
  let setRequestId!: (value: string) => void;
  const view = mountSolid(
    () => {
      const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
      const [disabled, updateDisabled] = createSignal(false);
      const [requestId, updateRequestId] = createSignal("question-request");
      setDisabled = updateDisabled;
      setRequestId = updateRequestId;
      return (
        <div>
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
            requestId={requestId()}
            sessionKey="agent:main:upload-session"
            selected={selected()}
            disabled={disabled()}
            onSelection={(values) => {
              selections(values);
              setSelected(new Set(values));
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
  const remove = await waitForSolid(() =>
    view.getByRole<HTMLButtonElement>("button", { name: "Remove" }),
  );
  setDisabled(true);
  await waitForSolid(() => expect(remove.disabled).toBe(true));
  expect(view.getByText("notes.txt")).toBeTruthy();
  expect(view.getByLabelText("Part")).toBe(input);
  setDisabled(false);
  await waitForSolid(() => expect(remove.disabled).toBe(false));
  remove.click();
  await waitForSolid(() => expect(view.queryByText("notes.txt")).toBeNull());
  expect(selections).toHaveBeenLastCalledWith([]);
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(selections).toHaveBeenCalledTimes(3));
  expect(view.getByText("notes.txt")).toBeTruthy();
  setRequestId("replacement-request");
  await waitForSolid(() => expect(view.queryByText("notes.txt")).toBeNull());
  expect(view.getByLabelText("Part")).toBe(input);
  expect(selections).toHaveBeenCalledTimes(3);
});

it("retires pending previews on disabled and request changes while retaining controls", async () => {
  const first = Promise.withResolvers<QuestionResourceActionResult>();
  const second = Promise.withResolvers<QuestionResourceActionResult>();
  const request = createGatewayRequestMock(async () => ({
    preview: { contents: [{ text: "Current preview" }] },
  }));
  request.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const application = createApplicationGateway();
  application.publish({
    ...application.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
  });
  // SAFETY: Text resource previews consume only the Gateway capability.
  const context = { gateway: application.gateway } as ApplicationContext;
  let setDisabled!: (value: boolean) => void;
  let setRequestId!: (value: string) => void;
  const view = mountSolid(
    () => {
      const [disabled, updateDisabled] = createSignal(false);
      const [requestId, updateRequestId] = createSignal("question-request");
      setDisabled = updateDisabled;
      setRequestId = updateRequestId;
      return (
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
          requestId={requestId()}
          sessionKey="agent:main:preview-session"
          selected={new Set()}
          disabled={disabled()}
        />
      );
    },
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  const button = await waitForSolid(() =>
    view.getByRole<HTMLButtonElement>("button", { name: "Preview resource: Bracket" }),
  );
  button.click();
  button.click();
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
  setDisabled(true);
  await waitForSolid(() => {
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(button.disabled).toBe(true);
  });
  first.resolve({ preview: { contents: [{ text: "Retired disabled preview" }] } });
  setDisabled(false);
  await waitForSolid(() => expect(button.disabled).toBe(false));
  expect(view.getByRole("button", { name: "Preview resource: Bracket" })).toBe(button);
  button.click();
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  setRequestId("replacement-request");
  await waitForSolid(() => expect(request.mock.calls[1]?.[2]?.signal?.aborted).toBe(true));
  second.resolve({ preview: { contents: [{ text: "Retired request preview" }] } });
  expect(view.getByRole("button", { name: "Preview resource: Bracket" })).toBe(button);
  button.click();
  await waitForSolid(() => expect(view.getByText("Current preview")).toBeTruthy());
  expect(view.queryByText("Retired disabled preview")).toBeNull();
  expect(view.queryByText("Retired request preview")).toBeNull();
  expect(request.mock.calls[2]?.[1]).toMatchObject({ requestId: "replacement-request" });
});
