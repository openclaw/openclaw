// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { createState } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { PaneAttachmentCatalog } from "./chat-pane-attachment-catalog.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.tsx";
import { loadSessionWorkspaceArtifacts } from "./components/chat-session-workspace-state.ts";

const upload = (seq: number, fileName: string) => ({
  role: "user",
  content: "",
  __openclaw: {
    id: `message-${seq}`,
    seq,
    media: [{ url: `media://inbound/${fileName}`, kind: "document", fileName }],
  },
});

async function openFiles(result: unknown) {
  // The loaded window holds only the newest messages; earlier ones need another page.
  const history: ChatHistoryResult = {
    sessionId: "attachment-session",
    messages: [upload(40, "duplicate.pdf"), upload(41, "latest.pdf")],
    hasMore: true,
  };
  const state = createState(history);
  const request = vi
    .spyOn(state.client!, "request")
    .mockImplementation(async (method: string) => (method === "artifacts.list" ? result : history));
  await loadChatHistory(state);
  await loadSessionWorkspaceArtifacts(state as unknown as ChatPageHost);
  const catalog = new PaneAttachmentCatalog();
  const showMessage = vi.fn();
  const chatProps = { sessionKey: state.sessionKey, paneId: "files" } as ChatProps;
  const read = () =>
    catalog.read({
      state: state as unknown as ChatPageHost,
      selectedSession: undefined,
      currentAgentId: "main",
      chatProps,
      paneChatProps: chatProps,
      gateway: {} as never,
      presentation: "desktop",
      workspacePresented: true,
      showMessage,
      sessionWorkspace: {} as never,
    });
  const labels = () => read()?.entries.map((entry) => entry.label);
  return { read, labels, request, showMessage };
}

it("lists older attachments once from the existing Files request, without loading more chat", async () => {
  const { read, labels, request, showMessage } = await openFiles({
    artifacts: [],
    attachments: {
      sessionId: "attachment-session",
      messages: [upload(2, "first.pdf"), upload(40, "duplicate.pdf"), upload(41, "latest.pdf")],
    },
  });
  expect(read()).toMatchObject({ coverage: "complete", omittedMedia: false });
  expect(labels()).toEqual(["first.pdf", "duplicate.pdf", "latest.pdf"]);
  read()?.entries[0]?.onShowMessage?.();
  expect(showMessage).toHaveBeenCalledWith("message-2");
  expect(
    request.mock.calls.map(([method]) => method).filter((method) => method === "artifacts.list"),
  ).toHaveLength(1);
});

it("retains the loaded tail and reports partial coverage when catalog metadata is capped", async () => {
  const { read, labels } = await openFiles({
    artifacts: [],
    attachments: {
      sessionId: "attachment-session",
      truncated: true,
      messages: [upload(2, "first.pdf"), upload(40, "duplicate.pdf")],
    },
  });
  expect(read()?.coverage).toBe("partial");
  expect(labels()).toEqual(["first.pdf", "duplicate.pdf", "latest.pdf"]);
});

it("does not claim full coverage for a legacy Gateway or another physical session", async () => {
  for (const result of [
    { artifacts: [] },
    { artifacts: [], attachments: { sessionId: "retired", messages: [upload(2, "retired.pdf")] } },
  ]) {
    const { read, labels } = await openFiles(result);
    expect(read()?.coverage).toBe("partial");
    expect(labels()).toEqual(["duplicate.pdf", "latest.pdf"]);
  }
});
