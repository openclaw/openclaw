import type { JSX } from "@solidjs/web";
import { Errored, Loading, onSettled } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginDetailLoadingHero } from "../plugins/detail-loading-hero.tsx";

/** A skill page's code arrives on demand: its header's space is held, and a failed load says so. */
export function SkillPageBoundary(props: { onBack: () => void; children: JSX.Element }) {
  let active = true;
  onSettled(() => () => {
    active = false;
  });
  return (
    <Errored
      fallback={(error, reset) => (
        <InlineAlert tone="danger" role="alert">
          {formatUiError(error())}{" "}
          <button class="btn" onClick={() => props.onBack()}>
            {t("common.back")}
          </button>{" "}
          <button
            class="btn"
            onClick={() =>
              isStaleChunkImportError(error())
                ? void retryStaleChunkReloadWhenReachable({ canReload: () => active })
                : reset()
            }
          >
            {t("common.retry")}
          </button>
        </InlineAlert>
      )}
    >
      <Loading fallback={<SkillPageLoading />}>{props.children}</Loading>
    </Errored>
  );
}

/** The page's header while what it shows is read, at the loaded header's size. */
export function SkillPageLoading(props: { breadcrumb?: JSX.Element }) {
  return (
    <section
      class="plugin-catalog-detail plugin-catalog-detail--rail plugin-catalog-detail--loading skill-page"
      aria-busy="true"
    >
      {props.breadcrumb ?? (
        <div class="plugins-settings-breadcrumb skill-page__crumb-reserve" aria-hidden="true" />
      )}
      <PluginDetailLoadingHero />
      <span class="sr-only" role="status">
        {t("common.loading")}
      </span>
    </section>
  );
}
