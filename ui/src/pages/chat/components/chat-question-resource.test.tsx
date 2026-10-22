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

const previewQuestion = {
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
} satisfies NonNullable<Parameters<typeof ChatQuestionResource>[0]["question"]>;
function mountResource(
  request: ReturnType<typeof createGatewayRequestMock>,
  upload = false,
  agentId?: string,
) {
  const application = createApplicationGateway();
  application.publish({
    ...application.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
    ...(upload
      ? {
          hello: {
            ...gatewayHelloForMethods(["mcp.app.formResource"]),
            policy: {
              attachments: { maxBytes: 1024, maxImageBytes: 1024 },
              maxPayload: 1024 * 1024,
            },
          },
        }
      : {}),
  });
  // SAFETY: These paths consume only Gateway capabilities and the upload policy.
  const context = { gateway: application.gateway } as ApplicationContext;
  const selections = vi.fn();
  const noSelection = new Set<string>();
  let setDisabled!: (value: boolean) => void;
  let setRequestId!: (value: string) => void;
  const view = mountSolid(
    () => {
      const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
      const [disabled, updateDisabled] = createSignal(false);
      const [requestId, updateRequestId] = createSignal("question-request");
      setDisabled = updateDisabled;
      setRequestId = updateRequestId;
      const resource = (
        <ChatQuestionResource
          question={
            upload
              ? {
                  ...previewQuestion,
                  question: "Upload a part",
                  options: [],
                  resource: { ...previewQuestion.resource, userOptions: { kind: "file" } },
                }
              : previewQuestion
          }
          requestId={requestId()}
          sessionKey={`agent:main:${upload ? "upload" : "preview"}-session`}
          agentId={agentId}
          selected={upload ? selected() : noSelection}
          disabled={disabled()}
          onSelection={
            upload
              ? (values) => {
                  selections(values);
                  setSelected(new Set(values));
                }
              : undefined
          }
        />
      );
      return upload ? <div>{resource}</div> : resource;
    },
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  return { view, selections, setDisabled, setRequestId };
}

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
  const { view } = mountResource(request, false, "main");

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
  const { view, selections, setDisabled, setRequestId } = mountResource(request, true);
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
  request.mockResolvedValueOnce({
    resources: [{ uri: "parts://notes", name: "updated-notes.txt" }],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(view.getByText("updated-notes.txt")).toBeTruthy());
  expect(view.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
  expect(view.getByRole("button", { name: "Remove" })).toBe(remove);
  expect(view.queryByText("notes.txt")).toBeNull();
  expect(selections).toHaveBeenLastCalledWith(["parts://notes"]);
  request.mockRejectedValueOnce(new Error("Resource upload failed"));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() =>
    expect(view.getByRole("alert").textContent).toBe("Resource upload failed"),
  );
  expect(view.getByText("updated-notes.txt")).toBeTruthy();
  expect(view.getByRole("button", { name: "Remove" })).toBe(remove);
  expect(selections).toHaveBeenCalledTimes(2);
  setDisabled(true);
  await waitForSolid(() => expect(remove.disabled).toBe(true));
  expect(view.getByText("updated-notes.txt")).toBeTruthy();
  expect(view.getByLabelText("Part")).toBe(input);
  setDisabled(false);
  await waitForSolid(() => expect(remove.disabled).toBe(false));
  remove.click();
  await waitForSolid(() => expect(view.queryByText("updated-notes.txt")).toBeNull());
  expect(selections).toHaveBeenLastCalledWith([]);
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(selections).toHaveBeenCalledTimes(4));
  expect(view.getByText("notes.txt")).toBeTruthy();
  setRequestId("replacement-request");
  await waitForSolid(() => expect(view.queryByText("notes.txt")).toBeNull());
  expect(view.getByLabelText("Part")).toBe(input);
  expect(selections).toHaveBeenCalledTimes(4);
});

it("retires pending previews on disabled and request changes while retaining controls", async () => {
  const first = Promise.withResolvers<QuestionResourceActionResult>();
  const second = Promise.withResolvers<QuestionResourceActionResult>();
  const request = createGatewayRequestMock(async () => ({
    preview: { contents: [{ text: "Current preview" }] },
  }));
  request.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const { view, setDisabled, setRequestId } = mountResource(request);
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
  await waitForSolid(() => {
    expect(request.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
    expect(button.disabled).toBe(false);
  });
  expect(view.getByRole("button", { name: "Preview resource: Bracket" })).toBe(button);
  button.click();
  await waitForSolid(() => {
    expect(view.getByText("Current preview")).toBeTruthy();
    expect(button.disabled).toBe(false);
  });
  second.reject(new Error("Retired request failed"));
  await second.promise.catch(() => {});
  expect(view.queryByText("Retired disabled preview")).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
  expect(request.mock.calls[2]?.[1]).toMatchObject({ requestId: "replacement-request" });
  request.mockRejectedValueOnce(new Error("Resource preview failed"));
  button.click();
  await waitForSolid(() => {
    expect(view.getByRole("alert").textContent).toBe("Resource preview failed");
    expect(button.disabled).toBe(false);
  });
  expect(view.getByText("Current preview")).toBeTruthy();
  const retry = Promise.withResolvers<QuestionResourceActionResult>();
  request.mockImplementationOnce(() => retry.promise);
  button.click();
  button.click();
  await waitForSolid(() => {
    expect(view.queryByRole("alert")).toBeNull();
    expect(request).toHaveBeenCalledTimes(5);
    expect(button.disabled).toBe(true);
    expect(view.getByRole("status").textContent).toBe("Loading…");
  });
  expect(view.getByText("Current preview")).toBeTruthy();
  expect(view.getByRole("button", { name: "Preview resource: Bracket" })).toBe(button);
  retry.reject(new Error("Resource retry failed"));
  await waitForSolid(() => {
    expect(view.getByRole("alert").textContent).toBe("Resource retry failed");
    expect(button.disabled).toBe(false);
  });
  expect(view.getByText("Current preview")).toBeTruthy();
  button.click();
  await waitForSolid(() => {
    expect(view.queryByRole("alert")).toBeNull();
    expect(request).toHaveBeenCalledTimes(6);
  });
});
