import { For, createMemo } from "solid-js";
import { icons } from "../../components/icons.ts";
import type { getLobsterdexEntries } from "../../components/lobster-dex.ts";
import type { LobsterPetPaletteId } from "../../components/lobster-pet-contract.ts";
import {
  canonicalLobsterLook,
  lobsterLookStyle,
  renderLobsterSvg,
} from "../../components/lobster-pet-look.ts";
import { LOBSTER_PALETTE_LORE, lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { getLocale, t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/lit-content.tsx";
// Page stars must override the shared mini-star rules loaded by lobster-pet-look.
import "../../styles/lobsterdex.css";

export type LobsterdexCopyFeedback = { paletteId: LobsterPetPaletteId; status: "copied" | "error" };
type LobsterdexViewProps = {
  entries: ReturnType<typeof getLobsterdexEntries>;
  copyFeedback?: LobsterdexCopyFeedback | null;
  onCopyLink?: (paletteId: LobsterPetPaletteId) => void;
};

function formatLobsterdexDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(getLocale());
}

export function LobsterdexView(props: LobsterdexViewProps) {
  const seenCount = createMemo(
    () => LOBSTER_PET_PALETTES.filter((palette) => props.entries.has(palette.id)).length,
  );
  const countLabel = createMemo(() =>
    t("quickSettings.appearance.lobsterdexSeen", {
      seen: String(seenCount()),
      total: String(LOBSTER_PET_PALETTES.length),
    }),
  );
  return (
    <section class="lobsterdex-page">
      <header
        class={[
          "lobsterdex-page__header",
          { "lobsterdex-page__header--complete": seenCount() === LOBSTER_PET_PALETTES.length },
        ]}
      >
        <div>
          <h2>{t("tabs.lobsterdex")}</h2>
          <p>{t("subtitles.lobsterdex")}</p>
        </div>
        <span class="lobsterdex-page__count">{countLabel()}</span>
      </header>
      <span class="sr-only" role="status">
        {props.copyFeedback?.status === "copied" ? t("common.copied") : undefined}
      </span>
      {props.copyFeedback?.status === "error" && (
        <div class="callout danger" role="alert">
          {t("common.copyFailed")}
        </div>
      )}
      <section class="lobsterdex-page__grid" aria-label={countLabel()}>
        <For each={LOBSTER_PET_PALETTES}>
          {(palette) => {
            const look = canonicalLobsterLook(palette);
            const entry = createMemo(() => props.entries.get(palette.id));
            const firstSeen = createMemo(() => {
              const timestamp = entry()?.firstSeenAt;
              return timestamp != null
                ? t("quickSettings.appearance.lobsterdexCardFirstVisited", {
                    date: formatLobsterdexDate(timestamp),
                  })
                : null;
            });
            const shinySeen = createMemo(() => {
              const timestamp = entry()?.shinySeenAt;
              return timestamp != null
                ? t("quickSettings.appearance.lobsterdexCardShinySeen", {
                    date: formatLobsterdexDate(timestamp),
                  })
                : null;
            });
            return (
              <article
                id={`lobsterdex-${palette.id}`}
                class={["lobsterdex-page__card", { "lobsterdex-page__card--unseen": !entry() }]}
              >
                <button
                  type="button"
                  class="lobsterdex-page__copy-link"
                  aria-label={t("quickSettings.appearance.lobsterdexCardCopyLink")}
                  onClick={() => props.onCopyLink?.(palette.id)}
                >
                  <span aria-hidden="true">
                    <LitContent
                      content={
                        props.copyFeedback?.status === "copied" &&
                        props.copyFeedback.paletteId === palette.id
                          ? icons.check
                          : icons.link
                      }
                    />
                  </span>
                </button>
                <div
                  class={[
                    `lobsterdex-page__sprite lobster-pet lobster-pet--palette-${palette.id}`,
                    { "lobsterdex__mini--unseen": !entry() },
                  ]}
                  style={lobsterLookStyle(look)}
                >
                  <LitContent content={renderLobsterSvg(look, { standalone: true })} />
                  {entry()?.shinySeenAt != null && (
                    <span class="lobsterdex__mini-star lobsterdex-page__star" aria-hidden="true">
                      ✦
                    </span>
                  )}
                </div>
                <h3>{entry() ? (entry()?.name ?? lobsterPaletteName(palette.id)) : "?"}</h3>
                <p class="lobsterdex-page__lore">
                  {entry()
                    ? LOBSTER_PALETTE_LORE[palette.id].flavor
                    : LOBSTER_PALETTE_LORE[palette.id].hint}
                </p>
                <div class="lobsterdex-page__dates">
                  {firstSeen() && (
                    <p class="lobsterdex-page__date">
                      <time>{firstSeen()}</time>
                    </p>
                  )}
                  {shinySeen() && (
                    <p class="lobsterdex-page__date">
                      <time>{shinySeen()}</time>
                    </p>
                  )}
                </div>
              </article>
            );
          }}
        </For>
      </section>
    </section>
  );
}
