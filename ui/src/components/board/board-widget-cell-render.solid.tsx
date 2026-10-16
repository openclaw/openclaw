import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { dynamic, type JSX } from "@solidjs/web";
import type { BoardWidget } from "../../lib/board/types.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function BoardCoreWidget(props: {
  tagName?: string;
  widget?: BoardWidget;
  session?: BoardGetParams;
  active: boolean;
}) {
  const Element = dynamic(() => props.tagName);
  return (
    <Element
      {...{
        "prop:widget": props.widget,
        "prop:session": props.session ?? { sessionKey: "" },
        "prop:active": props.active,
      }}
    />
  );
}

export function BoardWidgetRejected(props: { disabled: boolean; onRemove: () => void }) {
  return (
    <div class="board-widget__grant board-widget__grant--rejected" data-test-id="board-rejected">
      <strong>{t("board.widget.rejected")}</strong>
      <span>{t("board.widget.rejectedDetail")}</span>
      <button
        class="btn btn--small"
        type="button"
        disabled={props.disabled}
        onClick={() => props.onRemove()}
      >
        {t("board.widget.remove")}
      </button>
    </div>
  );
}

export function BoardDisabledPlugin(props: {
  pluginId: string;
  disabled: boolean;
  onRemove: () => void;
  children?: JSX.Element;
}) {
  return (
    <div class="board-widget__disabled-plugin" data-test-id="board-disabled-plugin">
      {props.children ?? (
        <strong>{t("board.widget.disabledPlugin", { pluginId: props.pluginId })}</strong>
      )}
      <button
        class="btn btn--small"
        type="button"
        disabled={props.disabled}
        onClick={() => props.onRemove()}
      >
        {t("board.widget.remove")}
      </button>
    </div>
  );
}
