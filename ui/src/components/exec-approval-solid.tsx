// Control UI modal presents approvals after an explicit operator action.
import { For, Show, createSignal, onSettled } from "solid-js";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../app/exec-approval.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import {
  ApprovalCountdown,
  approvalRemainingLabel,
  readApprovalTime,
} from "./approval-countdown.tsx";
import {
  approvalTitle,
  ApprovalAgentAvatar,
  ExecApprovalCard,
  resolveApprovalDecisions,
} from "./exec-approval-card-solid.tsx";
import "./modal-dialog.tsx";

export type ExecApprovalProps = {
  queue: readonly ExecApprovalRequest[];
  busy: boolean;
  connected: boolean;
  canGrant: boolean;
  errors: ReadonlyMap<string, string>;
  nodeNames?: ReadonlyMap<string, string>;
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
  const label = t("execApproval.morePending", { count: String(others.length) });
  return (
    <div class="exec-approval-list" aria-label={label}>
      <div class="exec-approval-list__heading">{label}</div>
      <For each={others}>
        {(entry) => {
          const command = entry.request.command;
          const agentId = entry.request.agentId?.trim();
          const agent = agentId || "—";
          return (
            <button
              class="exec-approval-list__item"
              type="button"
              aria-label={t("execApproval.reviewRequest", { agent, command })}
              onClick={() => params.onSelect(entry.id)}
            >
              <Show
                when={agentId}
                fallback={<span class="exec-approval-list__agent" aria-hidden="true" />}
              >
                {(id) => <ApprovalAgentAvatar agentId={id()} class="exec-approval-list__agent" />}
              </Show>
              <span class="exec-approval-list__command mono" title={command}>
                {command}
              </span>
              <span class="exec-approval-list__expiry" aria-hidden="true">
                <ApprovalCountdown expiresAtMs={entry.expiresAtMs} compact={true} />
              </span>
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
    let decide: ExecApprovalProps["onDecision"] | undefined;
    let deciding = () => false;
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
    onSettled(() => () => controls.delete(host));
    const handleKeydown = (event: KeyboardEvent) => {
      const props = bridgeProps.props;
      const request = active();
      if (
        !request ||
        event.defaultPrevented ||
        event.repeat ||
        props?.busy ||
        deciding() ||
        !props?.connected ||
        !props?.canGrant
      ) {
        return;
      }
      const decision = shortcutDecision(event);
      if (!decision || !resolveApprovalDecisions(request).includes(decision)) {
        return;
      }
      event.preventDefault();
      void decide?.(request.id, decision);
    };
    const handleCancel = (event: Event) => {
      if (deciding() || bridgeProps.props?.busy) {
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
            label={approvalTitle(active()!)}
            description={approvalRemainingLabel(
              active()!.expiresAtMs,
              readApprovalTime(active()!.expiresAtMs),
            )}
            onKeyDown={handleKeydown}
            onModal-cancel={handleCancel}
          >
            <div class="exec-approval-modal-stack">
              <ExecApprovalCard
                props={{
                  approval: active()!,
                  nodeDisplayName: bridgeProps.props!.nodeNames?.get(
                    active()!.request.nodeId ?? "",
                  ),
                  busy: bridgeProps.props!.busy,
                  connected: bridgeProps.props!.connected,
                  canGrant: bridgeProps.props!.canGrant,
                  error: bridgeProps.props!.errors.get(active()!.id) ?? null,
                  variant: "modal",
                  queueCount: queue().length,
                  renderPendingQueue: () =>
                    renderApprovalQueueList({
                      queue: queue(),
                      activeId: active()!.id,
                      onSelect: selectApproval,
                    }),
                  onDecision: bridgeProps.props!.onDecision,
                  onDecisionReady: (handler, busy) => {
                    decide = handler;
                    deciding = busy;
                  },
                }}
              />
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
