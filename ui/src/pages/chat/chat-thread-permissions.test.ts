/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { nativeMessage, text, toolResult } from "./chat-thread-fixtures.test-support.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import { createMessageGroupHarness } from "./components/chat-message-native.test-support.tsx";
import { settleToolBridges } from "./components/chat-tool-render.test-support.ts";
import { agentEvent, createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const permissionMissing = {
  nodeId: "example-mac",
  nodeName: "Example Mac",
  command: "screen.capture",
  capabilities: ["screenRecording"],
  state: "denied",
};
const permissionResult = (timestamp = Date.now()) =>
  toolResult("capture", "nodes", [text("Screen Recording permission is missing.")], timestamp, {
    isError: true,
    details: { permissionMissing },
  });
const call = (id: string, name: string, action: string) => ({
  type: "toolCall",
  id,
  name,
  arguments: { action },
});
const toolCards = (items: ReturnType<typeof buildItems>) =>
  items.flatMap((item) =>
    item.kind === "group"
      ? item.messages.flatMap(({ message }) => extractToolCardsCached(message))
      : [],
  );

it.each(["prepare_pr", "publish"])(
  "keeps a sibling permission request when GitHub %s details are hidden",
  (action) => {
    const outcome =
      action === "prepare_pr"
        ? { status: "started", async: true, yielded: true }
        : { status: "published" };
    const groups = buildItems({
      showToolCalls: false,
      messages: [
        nativeMessage(
          "assistant",
          [call("github", "github_publish", action), call("capture", "nodes", "screen_record")],
          1_000,
          { id: "batched-calls", seq: 1, runId: "run" },
          { runId: "run" },
        ),
        toolResult("github", "github_publish", [text(JSON.stringify(outcome))], 1_001, {
          runId: "run",
        }),
        { ...permissionResult(1_002), runId: "run" },
      ],
    });
    const cards = toolCards(groups);
    expect(cards.map((card) => card.name)).toEqual(["nodes"]);
    expect(cards[0]?.details).toEqual({ permissionMissing });
  },
);

it("projects a scoped permission event and replaces it with its persisted tool result", () => {
  const host = createHost({ chatRunId: "run" });
  const notice = { phase: "warning", kind: "permission_missing", permissionMissing };
  handleAgentEvent(host, agentEvent("other-run", 1, "notice", notice, "another-session"));
  expect(host.guardianNotices).toEqual([]);
  handleAgentEvent(host, agentEvent("run", 1, "notice", notice));
  const pending = buildItems({ guardianNotices: host.guardianNotices, showToolCalls: false });
  expect(pending.find((item) => item.kind === "notice")).toMatchObject({ permissionMissing });
  const restored = buildItems({
    messages: [permissionResult()],
    guardianNotices: host.guardianNotices,
    showToolCalls: false,
  });
  expect(restored.filter((item) => item.kind === "notice")).toEqual([]);
  const cards = toolCards(restored);
  expect(cards).toHaveLength(1);
  expect(cards[0]?.details).toEqual({ permissionMissing });
});

it("renders a persisted standalone tool result as a Grant card without expanding tool output", async () => {
  const [group] = groupMessages([{ kind: "message", key: "capture", message: permissionResult() }]);
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  if (!group || group.kind !== "group") {
    throw new Error("Expected a tool message group");
  }
  const view = createMessageGroupHarness(container);
  view.render(group, { assistantName: "OpenClaw", showReasoning: false });
  await settleToolBridges(container);
  expect(container.querySelector(".chat-permission-card")?.textContent).toContain(
    "Grant Screen Recording",
  );
  expect(container.querySelector(".chat-tool-msg-summary")).toBeNull();
});
