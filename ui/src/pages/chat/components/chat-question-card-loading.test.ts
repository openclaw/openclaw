/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  cancelStaleChunkRecovery,
  installStaleChunkReloadListener,
} from "../../../app/stale-chunk-reload.ts";
import * as localStorage from "../../../local-storage.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ComposerQuestionDock } from "./chat-composer-question.tsx";
import { questionPanelIn } from "./chat-question-card.test-support.ts";
import type { ChatQuestionCard, QuestionPanelProps } from "./chat-question-card.ts";

const { retryStale } = vi.hoisted(() => ({
  retryStale: vi.fn<(options: { canReload: () => boolean }) => Promise<boolean>>(),
}));
vi.mock("../../../app/stale-chunk-reload.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../app/stale-chunk-reload.ts")>();
  return {
    ...original,
    // Vitest wraps rejected module factories; browsers reject with the import error itself.
    isStaleChunkImportError: (error: unknown) =>
      original.isStaleChunkImportError(error instanceof Error ? (error.cause ?? error) : error),
    retryStaleChunkReloadWhenReachable: retryStale,
  };
});

let stopPreloadListener: (() => void) | undefined;
afterEach(() => {
  stopPreloadListener?.();
  stopPreloadListener = undefined;
  cancelStaleChunkRecovery();
  vi.doUnmock("./chat-question-panel.tsx");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function model(key: string, text: string, defaults?: string[]): QuestionPanelProps["model"] {
  const form = defaults ? { presentation: "form" as const, defaultAnswers: defaults } : {};
  return {
    requestKey: key,
    title: "Question",
    questions: [{ questionId: "answer", header: "Answer", question: text, options: [], ...form }],
    collapsed: false,
    disabled: false,
    drafts: new Map(),
  };
}
function mountDock(initial: QuestionPanelProps | null = null) {
  let updatePanel!: (value: QuestionPanelProps | null) => void;
  const { container } = mountSolid(() => {
    const [panel, setPanel] = createSignal(initial);
    updatePanel = setPanel;
    return createComponent(ComposerQuestionDock, {
      get panel() {
        return panel();
      },
    });
  });
  flush();
  return { container, updatePanel };
}

it("defers controls, retries loading, and mounts only the current connected request", async () => {
  const probe = createDeferred<Response>();
  const fetchMock = vi.fn<typeof fetch>().mockReturnValue(probe.promise);
  vi.stubGlobal("fetch", fetchMock);
  const guardKey = "openclaw.controlUi.staleChunkReloadBuildId";
  window.sessionStorage.removeItem(guardKey);
  vi.spyOn(localStorage, "getSafeSessionStorage").mockReturnValue(window.sessionStorage);
  const persist = vi.spyOn(Storage.prototype, "setItem");
  stopPreloadListener = installStaleChunkReloadListener();
  const initialLoad = createDeferred();
  const staleLoad = createDeferred();
  const retryLoad = createDeferred();
  const loadStarted = createDeferred();
  const load = vi.fn<() => Promise<void>>();
  load.mockReturnValueOnce(initialLoad.promise);
  load.mockReturnValueOnce(staleLoad.promise);
  load.mockReturnValueOnce(retryLoad.promise);
  const recovery = createDeferred<boolean>();
  retryStale.mockReturnValueOnce(recovery.promise).mockResolvedValueOnce(false);
  vi.doMock(import("./chat-question-panel.tsx"), async (importOriginal) => {
    const pending = load();
    loadStarted.resolve();
    await pending;
    return importOriginal();
  });
  const { container, updatePanel } = mountDock();
  expect(customElements.get("openclaw-chat-question-panel")).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
  const onSubmit = vi.fn();
  const props = { model: model("old-request", "Old question"), onSubmit };
  updatePanel(props);
  flush();
  const card = container.querySelector<ChatQuestionCard>("openclaw-chat-question-card")!;
  await Promise.all([card.updateComplete, loadStarted.promise]);
  expect(card.querySelector('[role="status"]')).not.toBeNull();
  expect(card.querySelector("openclaw-chat-question-panel")).toBeNull();
  const loadError = new Error("Synthetic load failure");
  initialLoad.reject(loadError);
  await waitForSolid(() =>
    expect(card.querySelector('[role="alert"]')?.textContent).toContain("Synthetic load failure"),
  );
  await card.updateComplete;
  expect(card.querySelector('[role="alert"]')?.textContent).toContain("Synthetic load failure");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledOnce();

  card.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => expect(card.querySelector('[role="status"]')).not.toBeNull());
  const staleError = new Error("Failed to fetch dynamically imported module");
  staleLoad.reject(staleError);
  const preloadError = new Event("vite:preloadError", { cancelable: true });
  Object.defineProperty(preloadError, "payload", { value: staleError });
  window.dispatchEvent(preloadError);
  await waitForSolid(() =>
    expect(card.querySelector('[role="alert"]')?.textContent).toContain(
      "Failed to fetch dynamically imported module",
    ),
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  card.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => expect(card.querySelector('[role="status"]')).not.toBeNull());
  const canReload = retryStale.mock.calls[0]![0].canReload;
  expect(canReload()).toBe(true);
  updatePanel({ ...props, model: { ...props.model } });
  flush();
  await card.updateComplete;
  expect(canReload()).toBe(true);
  updatePanel({
    model: model("current-request", "Current question", ["  current value  "]),
    onSubmit,
  });
  flush();
  await card.updateComplete;
  expect(canReload()).toBe(false);
  probe.resolve(new Response("", { status: 200 }));
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(persist).not.toHaveBeenCalledWith(guardKey, expect.any(String));
  recovery.resolve(false);
  await waitForSolid(() => expect(card.querySelector('[role="alert"]')).not.toBeNull());
  expect(load).toHaveBeenCalledTimes(2);
  card.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => expect(load).toHaveBeenCalledTimes(3));
  const { container: removed } = mountDock(props);
  const removedCard = removed.querySelector<ChatQuestionCard>("openclaw-chat-question-card")!;
  await removedCard.updateComplete;
  removed.remove();

  retryLoad.resolve();
  const panel = await questionPanelIn(container);
  expect(load).toHaveBeenCalledTimes(3);
  expect(card.textContent).toContain("Current question");
  expect(card.textContent).not.toContain("Old question");
  expect(removedCard.querySelector(".chat-question-panel")).toBeNull();
  expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));
  expect(props.model.drafts.size).toBe(0);
  expect(card.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("  current value  ");
  card.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ answer: ["  current value  "] });

  document.body.append(removed);
  await questionPanelIn(removed);
  expect(removedCard.textContent).toContain("Old question");
  expect(load).toHaveBeenCalledTimes(3);
});
