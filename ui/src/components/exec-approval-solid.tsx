// Control UI modal presents approvals after an explicit operator action.
import { For, createRenderEffect, createSignal, onCleanup } from "solid-js";
import { compactApprovalCommand } from "../app/approval-presentation.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../app/exec-approval.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import {
  approvalRemainingLabel,
  approvalTitle,
  ExecApprovalCard,
  resolveApprovalDecisions,
} from "./exec-approval-card-solid.tsx";
import { OpenClawModalDialog } from "./modal-dialog.ts";

export type ExecApprovalProps = {
  queue: readonly ExecApprovalRequest[];
  busy: boolean;
  canGrant: boolean;
  errors: ReadonlyMap<string, string>;
  onDecision: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
};

function renderApprovalQueueList(params: {
  queue: readonly ExecApprovalRequest[];
  activeId: string;
  onSelect: (approvalId: string) => void;
}) {
  const others = params.queue.filter((entry) => entry.id !== params.activeId);
  if (others.length === 0) {
    return undefined;
  }
  return (
    <div class="exec-approval-list" aria-label={t("execApproval.otherPending")}>
      <div class="exec-approval-list__heading">{t("execApproval.otherPending")}</div>
      <For each={others}>
        {(entry) => {
          const command = compactApprovalCommand(entry.request.command);
          const agent = entry.request.agentId?.trim() || "—";
          return (
            <button
              class="exec-approval-list__item"
              type="button"
              aria-label={t("execApproval.reviewRequest", { agent, command })}
              onClick={() => params.onSelect(entry.id)}
            >
              <span class="exec-approval-list__agent">{agent}</span>
              <span class="exec-approval-list__command mono">{command}</span>
              <openclaw-approval-countdown
                class="exec-approval-list__expiry"
                aria-hidden="true"
                prop:expiresAtMs={entry.expiresAtMs}
                prop:compact={true}
              />
            </button>
          );
        }}
      </For>
    </div>
  );
}

function keyEventComesFromTextEntry(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") !==
          null,
    );
}

// Authorization shortcuts require a Ctrl/Cmd chord: the modal steals focus
// when it opens, so a bare letter typed mid-sentence into the composer could
// otherwise approve a command the user never read.
function shortcutDecision(event: KeyboardEvent): ExecApprovalDecision | null {
  if (keyEventComesFromTextEntry(event)) {
    return null;
  }
  if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.approveAlways, event)) {
    return "allow-always";
  }
  if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.modifiedEnter, event)) {
    return "allow-once";
  }
  return matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.denyApproval, event) ? "deny" : null;
}

type Methods = { show(): void };
export type ExecApprovalElement = SolidBridgeElement<{ props?: ExecApprovalProps }, Methods> & {
  readonly dialogOpen: boolean;
};
const controls = new WeakMap<HTMLElement, { show(): void }>();

export const ExecApproval = defineSolidBridge<{ props?: ExecApprovalProps }, Methods>(
  "openclaw-exec-approval",
  (bridgeProps, host) => {
    host.style.display = "contents";
    const queue = () => bridgeProps.props?.queue ?? [];
    // A writable derivation pins the chosen request through queue reordering.
    const [selectedApprovalId, selectApproval] = createSignal<string | null>((previous) =>
      queue().some((entry) => entry.id === previous) ? previous! : (queue()[0]?.id ?? null),
    );
    const [explicitlyOpen, setExplicitlyOpen] = createSignal<boolean>(
      (previous) => queue().length > 0 && (previous ?? false),
    );
    const active = () => queue().find((entry) => entry.id === selectedApprovalId()) ?? queue()[0];
    let dialog: OpenClawModalDialog | undefined;
    controls.set(host, {
      show() {
        if (!queue().length) {
          return;
        }
        setExplicitlyOpen(true);
      },
    });
    Object.defineProperty(host, "dialogOpen", {
      configurable: true,
      get: () => explicitlyOpen() && queue().length > 0,
    });
    onCleanup(() => controls.delete(host));
    createRenderEffect(
      () => explicitlyOpen() && queue().length > 0,
      (open) => {
        if (open) {
          void host.updateComplete.then(() => dialog?.show());
        }
      },
    );
    const handleKeydown = (event: KeyboardEvent) => {
      const props = bridgeProps.props;
      const request = active();
      if (!request || event.defaultPrevented || event.repeat || props?.busy || !props?.canGrant) {
        return;
      }
      const decision = shortcutDecision(event);
      if (!decision || !resolveApprovalDecisions(request).includes(decision)) {
        return;
      }
      event.preventDefault();
      void props.onDecision(request.id, decision);
    };
    const handleCancel = (event: Event) => {
      if (bridgeProps.props?.busy) {
        event.preventDefault();
      } else {
        // Dismissal closes the view; it never denies the pending request.
        setExplicitlyOpen(false);
      }
    };
    return (
      <>
        {explicitlyOpen() && active() && bridgeProps.props ? (
          <openclaw-modal-dialog
            ref={(element) => {
              if (element instanceof OpenClawModalDialog) {
                dialog = element;
              }
            }}
            label={approvalTitle(active()!)}
            description={approvalRemainingLabel(active()!.expiresAtMs, Date.now())}
            onKeyDown={handleKeydown}
            onModal-cancel={handleCancel}
          >
            <div class="exec-approval-modal-stack">
              <ExecApprovalCard
                props={{
                  approval: active()!,
                  busy: bridgeProps.props!.busy,
                  canGrant: bridgeProps.props!.canGrant,
                  error: bridgeProps.props!.errors.get(active()!.id) ?? null,
                  variant: "modal",
                  queueCount: queue().length,
                  onDecision: bridgeProps.props!.onDecision,
                }}
              />
              {renderApprovalQueueList({
                queue: queue(),
                activeId: active()!.id,
                onSelect: selectApproval,
              })}
            </div>
          </openclaw-modal-dialog>
        ) : undefined}
      </>
    );
  },
  {
    properties: { props: { default: undefined, attribute: false } },
    methods: { show: (host) => controls.get(host)?.show() },
  },
);
