/* @vitest-environment jsdom */
import { createRoot, createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import * as confirmDialog from "../../components/confirm-dialog.ts";
import * as inputDialog from "../../components/input-dialog.tsx";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { showToast } from "../../lib/toast.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  activePlacementSession,
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import {
  readFileDraft,
  reviewRetainedFileDrafts,
  setFileDraft,
} from "./components/chat-file-drafts.ts";
import {
  getSessionWorkspace,
  openSessionWorkspacePreview,
  requestCloseSessionWorkspacePreview,
  setSessionWorkspacePreviewDraft,
} from "./components/chat-session-workspace-state.ts";
import type { SessionWorkspaceHost } from "./components/chat-session-workspace-types.ts";
import type { FileSidebarContent } from "./components/chat-sidebar-content-types.ts";
import { ChatSubagentMobileHeader } from "./components/chat-subagents-mobile.tsx";
import * as draftDialog from "./components/file-draft-recovery-dialog-loading.tsx";
import * as stopDialog from "./components/session-worker-stop-dialog.tsx";

vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/toast.ts")>()),
  showToast: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function paneFor(row: GatewaySessionRow) {
  const request = vi.fn(async () => ({}));
  const fixture = createTestChatPane({ client: createGatewayBrowserClientFixture({ request }) });
  fixture.pane.presented = true;
  fixture.state.sessionKey = row.key;
  fixture.state.currentSessionId = row.sessionId ?? null;
  fixture.state.sessionsResult = sessionsResult([row]);
  return { ...fixture, request };
}

it("reports a worker-stop dialog preparation failure without admitting a stop", async () => {
  const row = activePlacementSession();
  const { pane, state, request } = paneFor(row);
  vi.spyOn(stopDialog, "showSessionWorkerStopDialog").mockRejectedValueOnce(
    new Error("Worker confirmation unavailable"),
  );
  await pane.changeHeaderPlacement(row, "reclaim");
  expect(state.chatError).toBe("Worker confirmation unavailable");
  expect(request).not.toHaveBeenCalled();
  expect(pane.headerPresentation.placementReclaimingKey).toBeNull();
});

it.each([false, true])("scopes a new-group preparation failure (retired=%s)", async (retired) => {
  const row: GatewaySessionRow = {
    key: "agent:main:group",
    sessionId: "group-session",
    kind: "direct",
  };
  const { pane, state } = paneFor(row);
  const preparation = createDeferred<string | null>();
  const dialog = vi.spyOn(inputDialog, "showInputDialog").mockReturnValueOnce(preparation.promise);
  const operation = pane.handleHeaderSessionAction({ kind: "new-group" }, row);
  await waitForSolid(() => expect(dialog).toHaveBeenCalledOnce());
  if (retired) {
    pane.presented = false;
  }
  preparation.reject(new Error("Group dialog unavailable"));
  await operation;
  expect(state.chatError).toBe(retired ? null : "Group dialog unavailable");
});

it("shows a mobile confirmation failure, then lets the same Stop control retry", async () => {
  const confirmation = createDeferred<boolean>();
  const dialog = vi
    .spyOn(confirmDialog, "showConfirmDialog")
    .mockReturnValueOnce(confirmation.promise)
    .mockResolvedValueOnce(true);
  const onConfirm = vi.fn();
  const view = mountSolid(() => (
    <ChatSubagentMobileHeader
      sessionKey="agent:main:subagent:sample"
      title="Sample worker"
      backLabel="Back"
      onBack={() => {}}
      stop={{
        target: "sample-run",
        label: "Stop",
        accessibleLabel: "Stop sample worker",
        disabled: false,
        pending: false,
        confirmation: {
          title: "Stop worker",
          message: "Stop sample worker?",
          confirmLabel: "Stop",
          cancelLabel: "Cancel",
        },
        onConfirm,
      }}
    />
  ));
  const button = view.container.querySelector<HTMLButtonElement>(".chat-subagents-mobile__stop")!;
  button.click();
  await waitForSolid(() => expect(dialog).toHaveBeenCalledOnce());
  expect(button.disabled).toBe(false);
  confirmation.reject(new Error("Confirmation unavailable"));
  await waitForSolid(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Confirmation unavailable",
    ),
  );
  expect(onConfirm).not.toHaveBeenCalled();
  button.click();
  await waitForSolid(() => expect(onConfirm).toHaveBeenCalledOnce());
  await waitForSolid(() => expect(view.container.querySelector('[role="alert"]')).toBeNull());
  expect(view.container.querySelector(".chat-subagents-mobile__stop")).toBe(button);
});

it("drops a mobile preparation failure when the retained header changes runs", async () => {
  const confirmation = createDeferred<boolean>();
  vi.spyOn(confirmDialog, "showConfirmDialog").mockReturnValueOnce(confirmation.promise);
  const [target, setTarget] = createRoot((dispose) => {
    onTestFinished(dispose);
    return createSignal("first-run");
  });
  const onConfirm = vi.fn();
  const view = mountSolid(() => (
    <ChatSubagentMobileHeader
      sessionKey="agent:main:subagent:sample"
      title="Sample worker"
      backLabel="Back"
      onBack={() => {}}
      stop={{
        target: target(),
        label: "Stop",
        accessibleLabel: "Stop sample worker",
        disabled: false,
        pending: false,
        confirmation: {
          title: "Stop worker",
          message: "Stop?",
          confirmLabel: "Stop",
          cancelLabel: "Cancel",
        },
        onConfirm,
      }}
    />
  ));
  const button = view.container.querySelector<HTMLButtonElement>(".chat-subagents-mobile__stop")!;
  button.click();
  setTarget("replacement-run");
  confirmation.reject(new Error("Retired confirmation unavailable"));
  await expect(confirmation.promise).rejects.toThrow("Retired confirmation unavailable");
  await waitForSolid(() => expect(view.container.querySelector('[role="alert"]')).toBeNull());
  expect(view.container.querySelector(".chat-subagents-mobile__stop")).toBe(button);
  expect(onConfirm).not.toHaveBeenCalled();
});

function dirtyPreview(editable: boolean) {
  const state: SessionWorkspaceHost = {
    sessionKey: "agent:main:files",
    connectionEpoch: 1,
    connected: true,
    client: createGatewayBrowserClientFixture(),
    sessions: createSessionCapabilityFixture(),
    hello: null,
    sidebarContent: null,
    handleOpenSidebar: vi.fn(),
  };
  const file: FileSidebarContent = {
    kind: "file",
    path: "notes.md",
    name: "notes.md",
    content: "Original",
    ...(editable ? { edit: { hash: "original", save: vi.fn(), fetchLatest: vi.fn() } } : {}),
  };
  const preview = openSessionWorkspacePreview(state, "file:notes.md", "notes.md", file);
  setFileDraft(file, { content: "Unsaved notes", expectedHash: "original" });
  const save = vi.fn();
  const discard = vi.fn();
  setSessionWorkspacePreviewDraft(state, preview.id, {
    file,
    editing: editable,
    dirty: true,
    saving: false,
    save,
    discard,
  });
  return { state, file, preview, save, discard };
}

it("retains dirty workspace content when the close confirmation cannot open", async () => {
  const { state, file, preview, save, discard } = dirtyPreview(true);
  vi.spyOn(confirmDialog, "showConfirmChoiceDialog").mockRejectedValueOnce(
    new Error("Close dialog unavailable"),
  );
  try {
    expect(await requestCloseSessionWorkspacePreview(state, preview.id)).toBe(false);
    expect(getSessionWorkspace(state).previews).toContain(preview);
    expect(readFileDraft(file)?.content).toBe("Unsaved notes");
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({ message: "Close dialog unavailable" });
  } finally {
    setFileDraft(file, null);
  }
});

it("keeps reload blocked and retries retained-draft review after preparation failure", async () => {
  const { file } = dirtyPreview(false);
  const review = vi
    .spyOn(draftDialog, "reviewFileDrafts")
    .mockRejectedValueOnce(new Error("Draft review unavailable"))
    .mockResolvedValueOnce(undefined);
  try {
    expect(canReloadControlUiDocument(true)).toBe(false);
    const toast = vi.mocked(showToast).mock.calls.at(-1)?.[0];
    expect(toast?.onAction).toBeDefined();
    toast!.onAction!();
    await waitForSolid(() =>
      expect(showToast).toHaveBeenCalledWith({ message: "Draft review unavailable" }),
    );
    expect(readFileDraft(file)?.content).toBe("Unsaved notes");
    expect(canReloadControlUiDocument()).toBe(false);
    await reviewRetainedFileDrafts();
    expect(review).toHaveBeenCalledTimes(2);
  } finally {
    setFileDraft(file, null);
  }
});
