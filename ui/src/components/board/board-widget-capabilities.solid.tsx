import type { JSX as SolidJSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardGrantDecision } from "../../lib/board/view-types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../tooltip.ts";

export function BoardPendingCapabilities(props: {
  widget: BoardWidget;
  disabled: boolean;
  onGrant: (decision: BoardGrantDecision) => void;
  error?: SolidJSX.Element;
}) {
  const groups = () =>
    [
      ["board.widget.networkAccess", props.widget.declared?.netOrigins ?? []],
      ["board.widget.hostTools", props.widget.declared?.tools ?? []],
    ] as const;
  return (
    <div class="board-widget__grant board-widget__grant--pending" data-test-id="board-pending">
      <div class="board-widget__grant-mark" aria-hidden="true">
        !
      </div>
      <strong>{t("board.widget.needsApproval")}</strong>
      <Show
        when={groups().some(([, values]) => values.length > 0)}
        fallback={
          <Show
            when={props.widget.declaredSummary?.length}
            fallback={<span>{t("board.widget.needsApprovalDetail")}</span>}
          >
            <ul class="board-widget__grant-summary">
              <For keyed={false} each={props.widget.declaredSummary}>
                {(summary) => <li>{summary()}</li>}
              </For>
            </ul>
          </Show>
        }
      >
        <div class="board-widget__grant-groups">
          <For keyed={false} each={groups()}>
            {(group) => (
              <Show when={group()[1].length > 0}>
                <section>
                  <strong>{t(group()[0])}</strong>
                  <ul class="board-widget__grant-summary">
                    <For keyed={false} each={group()[1]}>
                      {(capability) => <li>{capability()}</li>}
                    </For>
                  </ul>
                </section>
              </Show>
            )}
          </For>
        </div>
      </Show>
      <div class="board-widget__grant-actions">
        <button
          class="btn btn--small btn--primary"
          type="button"
          data-test-id="board-grant-allow"
          disabled={props.disabled}
          onClick={() => props.onGrant("granted")}
        >
          {t("board.widget.allow")}
        </button>
        <button
          class="btn btn--small"
          type="button"
          data-test-id="board-grant-reject"
          disabled={props.disabled}
          onClick={() => props.onGrant("rejected")}
        >
          {t("board.widget.reject")}
        </button>
      </div>
      {props.error}
    </div>
  );
}

export function BoardGrantedCapabilities(props: {
  widget: BoardWidget;
  presentation?: "tooltip" | "details";
}) {
  const capabilities = () => [
    ...(props.widget.declared?.netOrigins ?? []).map((origin) =>
      t("board.widget.networkCapability", { capability: origin }),
    ),
    ...(props.widget.declared?.tools ?? []).map((tool) =>
      t("board.widget.toolCapability", { capability: tool }),
    ),
  ];
  return (
    <Show when={props.widget.grantState === "granted" && capabilities().length > 0}>
      <Show
        when={props.presentation === "details"}
        fallback={
          <openclaw-tooltip
            prop:content={`${t("board.widget.activeCapabilities")}\n${capabilities().join("\n")}`}
          >
            <span class="board-widget__capabilities" data-test-id="board-capabilities-granted">
              {t("board.widget.granted")}
            </span>
          </openclaw-tooltip>
        }
      >
        <div
          class="board-widget__menu-capabilities"
          role="note"
          aria-label={t("board.widget.activeCapabilities")}
        >
          <strong>{t("board.widget.activeCapabilities")}</strong>
          <ul>
            <For keyed={false} each={capabilities()}>
              {(capability) => <li>{capability()}</li>}
            </For>
          </ul>
        </div>
      </Show>
    </Show>
  );
}
