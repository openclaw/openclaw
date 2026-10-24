import { dynamic } from "@solidjs/web";
import { createSignal, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { registerBoardDocumentEnglish } from "../../i18n/locales/en-board-document.ts";
import type { getPluginWidgetKindContribution } from "../../lib/board/widgets/index.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { LazyViewError } from "../solid/lazy-view-error.tsx";
import type { BoardWidgetCellProps } from "./board-widget-cell-options.ts";

registerEnglishCatalog(registerBoardDocumentEnglish);

const CORE_BOARD_WIDGET_COMPONENTS = {
  "session:progress": lazy(() => import("../../lib/board/widgets/session-progress.tsx"), {
    export: "SessionProgressWidget",
  }),
  "session:report": lazy(() => import("../../lib/board/widgets/report.tsx"), {
    export: "ReportWidget",
  }),
  "session:website": lazy(() => import("../../lib/board/widgets/website.tsx"), {
    export: "WebsiteWidget",
  }),
  "browser:dashboard": lazy(() => import("../../lib/board/widgets/browser.tsx"), {
    export: "BrowserDashboardWidget",
  }),
};

export function CoreBoardWidget(
  props: Pick<BoardWidgetCellProps, "widget" | "session"> & {
    active: boolean;
    contribution: NonNullable<ReturnType<typeof getPluginWidgetKindContribution>>;
  },
) {
  // A hidden board stays cold initially, then retains its mounted widget on return.
  const [activated] = createSignal((previous = false) => previous || props.active);
  const Widget = dynamic(() => CORE_BOARD_WIDGET_COMPONENTS[props.contribution.kind]);
  return (
    <Show when={activated()}>
      <Errored
        fallback={(error, reset) => (
          <Show when={props.active}>
            <CoreBoardWidgetLoadError
              error={error()}
              label={props.contribution.label}
              reset={reset}
            />
          </Show>
        )}
      >
        <Loading
          fallback={<p class="board-widget__plugin-loading">{t("board.widget.pluginLoading")}</p>}
        >
          <Widget
            widget={props.widget}
            session={props.session ?? { sessionKey: "" }}
            active={props.active}
          />
        </Loading>
      </Errored>
    </Show>
  );
}

function CoreBoardWidgetLoadError(props: { error: unknown; label: string; reset: () => void }) {
  let connected = true;
  onSettled(() => () => {
    connected = false;
    if (isStaleChunkImportError(props.error)) {
      cancelStaleChunkRecovery();
    }
  });
  const retry = async () => {
    const reloading =
      isStaleChunkImportError(props.error) &&
      (await retryStaleChunkReloadWhenReachable({ canReload: () => connected }));
    if (connected && !reloading) {
      props.reset();
    }
  };
  return (
    <LazyViewError
      error={props.error}
      stale={isStaleChunkImportError(props.error)}
      subtitle={props.label}
      onRetry={() => void retry()}
    />
  );
}
