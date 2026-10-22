import { createErrorBoundary } from "@solidjs/signals";
import { action, createMemo, createOptimistic, createSignal, refresh } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";
import { showToast } from "../../../lib/toast.ts";

export type WidgetPinTarget = {
  board: BoardProvider;
  name: string;
  viewId: string;
  mcpApp: boolean;
};

export function WidgetPinButton(props: { target: WidgetPinTarget; title?: string }) {
  const ownerPinned = createMemo(() =>
    projectSource(props.target.board.snapshot$, {
      read: (snapshot) =>
        snapshot.value.widgets.some((widget) => widget.name === props.target.name),
      subscribe: (snapshot, notify) => snapshot.subscribe(notify),
      equality: Object.is,
    }),
  );
  const [pinned, setPinned] = createOptimistic(() => ownerPinned().read());
  const [saving, setSaving] = createOptimistic(false);
  const [attempt, setAttempt] = createSignal<Promise<void>>();
  let admitted = false;
  let button!: HTMLButtonElement;
  const present = action(function* (completion: Promise<void>) {
    setSaving(true);
    setPinned(true);
    try {
      yield completion;
      yield refresh(pinned);
    } catch (error) {
      if (button.isConnected) {
        showToast({ message: t("chat.toolCards.pinToDashboardFailed") });
      }
      throw error;
    }
  });
  const label = () =>
    t(
      saving()
        ? "chat.toolCards.pinToDashboardPending"
        : pinned()
          ? "chat.toolCards.pinnedToDashboard"
          : "chat.toolCards.pinToDashboard",
    );
  const failed = createMemo(() => {
    const completion = attempt();
    const outcome = createMemo(() => completion, { loadingValue: undefined });
    // Only the native title's failure fact belongs to this boundary, not its optimistic label.
    return createErrorBoundary(
      () => {
        outcome();
        return false;
      },
      () => true,
    );
  });
  return (
    <button
      ref={(element) => (button = element)}
      class="btn btn--ghost btn--icon chat-tool-card__widget-action"
      type="button"
      data-pin-widget
      disabled={saving() || pinned()}
      data-pinned={!saving() && pinned() ? "" : undefined}
      title={
        !saving() && !pinned() && failed()() ? t("chat.toolCards.pinToDashboardFailed") : label()
      }
      aria-label={label()}
      onClick={() => {
        // Solid writes flush later; admission still prevents two same-task clicks.
        if (admitted || ownerPinned().read()) {
          return;
        }
        admitted = true;
        const target = props.target;
        const title = props.title?.trim();
        const identity = { name: target.name, ...(title ? { title } : {}) };
        const completion = target.mcpApp
          ? target.board.pinMcpApp({ ...identity, viewId: target.viewId })
          : target.board.pinWidget({ ...identity, docId: target.viewId });
        const result = present(completion);
        void setAttempt(result);
        void result
          .finally(() => {
            admitted = false;
          })
          .catch(() => undefined);
      }}
    >
      <Icon name="pin" />
    </button>
  );
}
