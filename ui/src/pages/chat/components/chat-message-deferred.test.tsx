import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { NodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import type { ApplicationContext } from "../../../app/context.ts";
import { createNativeDeviceSettingsCapability } from "../../../app/native-device-settings.ts";
import { prepareChatMessageRender } from "../../../lib/chat/message-display.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../../test-helpers/native-device-settings.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatNoticeDetails } from "./chat-divider.tsx";
import { prepareGroupedMessage } from "./chat-message-bubble-presentation.ts";
import { ToolMessage } from "./chat-message-bubble-tools.tsx";
import { ToolPreview } from "./chat-message-deferred.tsx";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

const moduleReady = vi.hoisted(() => Promise.withResolvers<void>());
// mock-isolation: Control lazy module readiness independently of the widget renderer and catalog setup.
vi.mock("./widget-card-view.tsx", async () => {
  await moduleReady.promise;
  return { AssistantViewPreview: () => <span>Widget renderer ready</span> };
});

it("loads permission recovery for tool cards, tool messages, and notices with current requests", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  snapshot.device.nodeId = "current-mac";
  snapshot.permissions.entries = [{ id: "screenRecording", status: "granted" }];
  vi.stubGlobal("webkit", {
    messageHandlers: {
      openclawDeviceSettings: { postMessage: vi.fn().mockResolvedValue(snapshot) },
    },
  });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  const native = createNativeDeviceSettingsCapability();
  if (!native) {
    throw new Error("Expected native permission capability");
  }
  onTestFinished(() => {
    native.dispose();
    vi.unstubAllGlobals();
  });
  // SAFETY: These consumers use native settings and the absence of a plugin replacement.
  const context = {
    nativeDeviceSettings: native,
    plugins: { selectedReplacement: () => undefined, subscribe: () => () => undefined },
  } as unknown as ApplicationContext;
  const previousRetry = vi.fn();
  const currentRetry = vi.fn();
  let replaceRequest!: () => void;
  const view = mountSolid(
    () => {
      const [request, setRequest] = createSignal<NodePermissionRequest>({
        nodeId: "retired-mac",
        nodeName: "Retired Mac",
        command: "screen.capture",
        capabilities: ["screenRecording"],
        state: "denied",
      });
      const [retry, setRetry] = createSignal<(message: string) => void>(() => previousRetry);
      replaceRequest = () => {
        setRequest({ ...request(), nodeId: "current-mac", nodeName: "Current Mac" });
        setRetry(() => currentRetry);
      };
      const card = () => ({
        id: "permission-tool",
        name: "screen.capture",
        args: {},
        details: { permissionMissing: request() },
      });
      const options = () => ({
        isStreaming: false,
        showReasoning: false,
        onPermissionRetry: retry(),
      });
      const state = () =>
        prepareGroupedMessage(
          prepareChatMessageRender({
            role: "assistant",
            content: [{ type: "toolcall", ...card(), arguments: {} }],
          }),
          "permission-message",
          options(),
        );
      return (
        <>
          <ChatToolCard
            card={card()}
            options={{
              messageKey: "permission-card",
              expanded: false,
              onToggleExpanded: vi.fn(),
              onPermissionRetry: retry(),
            }}
          />
          <ToolMessage
            state={state}
            options={options()}
            messageKey="permission-message"
            renderContents={() => null}
          />
          <ChatNoticeDetails
            item={{
              kind: "notice",
              key: "permission-notice",
              timestamp: 1,
              text: "",
              permissionMissing: request(),
            }}
            onPermissionRetry={retry()}
          />
        </>
      );
    },
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  onTestFinished(view.unmount);
  flush();
  expect(view.container.querySelector(".chat-permission-card")).toBeNull();
  replaceRequest();
  flush();
  await waitForSolid(() =>
    expect(view.getAllByRole("button", { name: "Try again" })).toHaveLength(3),
  );
  expect(view.container.textContent).not.toContain("Retired Mac");
  for (const button of view.getAllByRole("button", { name: "Try again" })) {
    button.click();
  }
  expect(previousRetry).not.toHaveBeenCalled();
  expect(currentRetry.mock.calls).toEqual([
    ["I granted Screen Recording, try again."],
    ["I granted Screen Recording, try again."],
    ["I granted Screen Recording, try again."],
  ]);
});

it("reserves declared and saved widget height before the lazy renderer arrives", async () => {
  let setSavedHeight!: (height: number | undefined) => void;
  const mounted = mountSolid(() => {
    const [savedHeight, setHeight] = createSignal<number>();
    setSavedHeight = setHeight;
    return (
      <ToolPreview
        preview={{
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          url: "/chart",
          preferredHeight: 220,
        }}
        surface="chat_message"
        options={{
          widgetLayout: {
            read: () => savedHeight(),
            readRows: () => undefined,
            write: () => undefined,
            writeRows: () => {},
            invalidateRow: () => {},
          },
        }}
      />
    );
  });
  try {
    flush();
    const placeholder = () =>
      mounted.container.querySelector<HTMLElement>(".chat-tool-card__preview");
    expect(placeholder()?.style.minHeight).toBe("220px");
    expect(mounted.container.textContent).not.toContain("Widget renderer ready");
    setSavedHeight(700);
    flush();
    expect(placeholder()?.style.minHeight).toBe("700px");
    moduleReady.resolve();
    await waitForSolid(() =>
      expect(mounted.container.textContent).toContain("Widget renderer ready"),
    );
    expect(placeholder()).toBeNull();
  } finally {
    moduleReady.resolve();
    mounted.unmount();
  }
});
