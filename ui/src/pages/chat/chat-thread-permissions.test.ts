/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import { renderMessageGroup } from "./components/chat-message.ts";
import { renderToolFixture } from "./components/chat-tool-render.test-support.ts";
import { agentEvent, createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const permissionMissing = {
  nodeId: "example-mac",
  nodeName: "Example Mac",
  command: "screen.capture",
  capabilities: ["screenRecording"],
  state: "denied",
};

it("projects a scoped permission event and replaces it with its persisted tool result", () => {
  const host = createHost({ chatRunId: "run" });
  const notice = { phase: "warning", kind: "permission_missing", permissionMissing };
  handleAgentEvent(host, agentEvent("other-run", 1, "notice", notice, "another-session"));
  expect(host.guardianNotices).toEqual([]);
  handleAgentEvent(host, agentEvent("run", 1, "notice", notice));
  const pending = buildItems({ guardianNotices: host.guardianNotices, showToolCalls: false });
  expect(pending.find((item) => item.kind === "notice")).toMatchObject({ permissionMissing });
  const result = {
    role: "toolResult",
    toolCallId: "capture",
    toolName: "nodes",
    timestamp: Date.now(),
    content: [{ type: "text", text: "Screen Recording permission is missing." }],
    details: { permissionMissing },
    isError: true,
  };
  const restored = buildItems({
    messages: [result],
    guardianNotices: host.guardianNotices,
    showToolCalls: false,
  });
  expect(restored.filter((item) => item.kind === "notice")).toEqual([]);
  const cards = restored.flatMap((item) =>
    item.kind === "group"
      ? item.messages.flatMap(({ message }) => extractToolCardsCached(message))
      : [],
  );
  expect(cards).toHaveLength(1);
  expect(cards[0]?.details).toEqual({ permissionMissing });
});

it("renders a persisted standalone tool result as a Grant card without expanding tool output", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  snapshot.device.nodeId = "example-mac";
  snapshot.permissions.entries = [{ id: "screenRecording", status: "denied" }];
  const post = vi.fn().mockResolvedValue(snapshot);
  vi.stubGlobal("webkit", { messageHandlers: { openclawDeviceSettings: { postMessage: post } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  const nativeDeviceSettings = createNativeDeviceSettingsCapability();
  onTestFinished(() => {
    nativeDeviceSettings?.dispose();
    vi.unstubAllGlobals();
  });
  const result = {
    role: "toolResult",
    toolCallId: "capture",
    toolName: "nodes",
    timestamp: Date.now(),
    content: [{ type: "text", text: "Screen Recording permission is missing." }],
    details: { permissionMissing },
    isError: true,
  };
  const [group] = groupMessages([{ kind: "message", key: "capture", message: result }]);
  // SAFETY: this transcript leaf consumes only the native settings owner.
  const container = createApplicationContextProvider({
    nativeDeviceSettings,
  } as ApplicationContext);
  if (!group || group.kind !== "group") {
    throw new Error("Expected a tool message group");
  }
  await renderToolFixture(renderMessageGroup(group, { assistantName: "OpenClaw" }), container);
  expect(container.querySelector(".chat-permission-card")?.textContent).toContain(
    "Grant Screen Recording",
  );
  expect(container.querySelector(".chat-tool-msg-summary")).toBeNull();
  const button = container.querySelector<HTMLButtonElement>(".chat-permission-card button");
  expect(button?.textContent).toBe("Grant Screen Recording");
  button?.click();
  expect(post).toHaveBeenCalledWith({ type: "resolve-permission", request: permissionMissing });
});
