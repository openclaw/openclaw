/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

const { retryStale } = vi.hoisted(() => ({
  retryStale: vi.fn<(options: { canReload: () => boolean }) => Promise<boolean>>(),
}));
vi.mock("../../../app/stale-chunk-reload.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../app/stale-chunk-reload.ts")>();
  return {
    ...original,
    // Vitest wraps rejected module factories; browsers expose the import error itself.
    isStaleChunkImportError: (error: unknown) =>
      original.isStaleChunkImportError(error instanceof Error ? (error.cause ?? error) : error),
    retryStaleChunkReloadWhenReachable: retryStale,
  };
});

it("keeps card chrome through import recovery and retains the current resolved row", async () => {
  const initialLoad = createDeferred();
  const staleLoad = createDeferred();
  const readyLoad = createDeferred();
  const recovery = createDeferred<boolean>();
  let pending = initialLoad.promise;
  const load = vi.fn(() => pending);
  retryStale.mockReturnValue(recovery.promise);
  vi.doMock(import("./chat-tool-card-row.solid.tsx"), async (original) => {
    await load();
    return original();
  });
  onTestFinished(() => {
    initialLoad.resolve();
    staleLoad.resolve();
    readyLoad.resolve();
    recovery.resolve(false);
    vi.doUnmock("./chat-tool-card-row.solid.tsx");
  });
  const toggle = vi.fn();
  const initialCard: ToolCard = {
    id: "exec",
    name: "tool_call",
    args: { id: "exec", args: { command: "echo before" } },
  };
  const [card, setCard] = createSignal(initialCard);
  const root = mountSolid(() => (
    <>
      <ChatToolCard
        card={card()}
        options={{ messageKey: "lazy-row", expanded: false, onToggleExpanded: toggle }}
      />
      <GroupedMessage
        preparation={prepareChatMessageRender({ role: "toolResult", content: "Example output" })}
        messageKey="tool-message"
        options={{ isStreaming: true, showReasoning: false }}
      />
      <ChatToolCard
        card={{
          id: "permission",
          name: "exec",
          details: {
            permissionMissing: {
              nodeId: "example-mac",
              nodeName: "Example Mac",
              command: "screen.capture",
              capabilities: ["screenRecording"],
              state: "denied",
            },
          },
        }}
        options={{ messageKey: "permission", expanded: false, onToggleExpanded: vi.fn() }}
      />
      <ChatToolCard
        card={{
          id: "progress",
          name: "progress_card",
          args: { plan: [{ step: "Read source", status: "completed" }] },
          completed: true,
        }}
        options={{ messageKey: "progress", expanded: false, onToggleExpanded: vi.fn() }}
      />
    </>
  ));
  onTestFinished(root.unmount);
  flush();
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  const placeholder = root.container.querySelector<HTMLButtonElement>(".chat-tool-row[aria-busy]")!;
  expect(placeholder.disabled).toBe(true);
  expect(placeholder.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Exec");
  expect(placeholder.querySelector(".chat-tool-disclosure__content")).not.toBeNull();
  expect(placeholder.querySelector(".chat-tool-row__chevron")).not.toBeNull();
  expect(root.container.querySelector(".chat-permission-card")).not.toBeNull();
  expect(root.container.querySelector(".chat-progress-card-receipt")).not.toBeNull();
  initialLoad.reject(new Error("Synthetic row import failure"));
  await waitForSolid(() =>
    expect(root.container.querySelectorAll('[role="alert"]')).toHaveLength(2),
  );
  expect(root.container.querySelector('button [role="alert"]')).toBeNull();
  expect(root.container.querySelector("button button")).toBeNull();
  const initialCalls = load.mock.calls.length;
  pending = staleLoad.promise;
  root.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await vi.waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(initialCalls));
  staleLoad.reject(new Error("Failed to fetch dynamically imported module"));
  await waitForSolid(() =>
    expect(root.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Failed to fetch",
    ),
  );
  root.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => expect(retryStale).toHaveBeenCalledOnce());
  const canReload = retryStale.mock.calls[0]![0].canReload;
  expect(canReload()).toBe(true);
  setCard({ id: "current-exec", name: "exec", args: { command: "echo after" } });
  flush();
  expect(canReload()).toBe(false);
  recovery.resolve(false);
  await waitForSolid(() =>
    expect(root.container.querySelectorAll('[role="alert"]')).toHaveLength(2),
  );
  const failedCalls = load.mock.calls.length;
  pending = readyLoad.promise;
  for (const retry of root.container.querySelectorAll<HTMLButtonElement>(
    ".lazy-view-error__action",
  )) {
    retry.click();
  }
  await vi.waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(failedCalls));
  readyLoad.resolve();
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(root.container.querySelector(".chat-tool-row__cmd")?.textContent).toBe("echo after"),
  );
  expect(root.container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  expect(root.container.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe("tool");
  const row = root.container.querySelector<HTMLButtonElement>("button.chat-tool-row")!;
  expect(root.container.querySelector(".chat-tool-row[aria-busy]")).toBeNull();
  row.click();
  expect(toggle).toHaveBeenCalledWith("current-exec");
  setCard({ id: "current-exec", name: "exec", args: { command: "echo latest" } });
  flush();
  expect(root.container.querySelector("button.chat-tool-row")).toBe(row);
  expect(root.container.querySelector(".chat-tool-row[aria-busy]")).toBeNull();
  expect(row.querySelector(".chat-tool-row__cmd")?.textContent).toBe("echo latest");
});
