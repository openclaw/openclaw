import { createMemo, createSignal, For, onSettled } from "solid-js";
import "../../styles/settings.css";
import { pathForRoute } from "../../app-route-paths.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import type { getLobsterdexEntries } from "../../components/lobster-dex.ts";
import { LobsterSvg } from "../../components/lobster-pet-artwork.tsx";
import type { LobsterPetPaletteId } from "../../components/lobster-pet-contract.ts";
import { canonicalLobsterLook, lobsterLookStyle } from "../../components/lobster-pet-identity.ts";
import { LOBSTER_PALETTE_LORE, lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerPreferencesEnglish } from "../../i18n/locales/en-preferences.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectLobsterdex } from "../../lib/reactive/events-browser.ts";
import { registerEnglishCatalog, t, getLocale } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
// Page stars must override the shared mini-star rules loaded by lobster-pet-look.
import "../../styles/lobsterdex.css";

registerEnglishCatalog(registerPreferencesEnglish);

type LobsterdexCopyFeedback = { paletteId: LobsterPetPaletteId; status: "copied" | "error" };

function formatLobsterdexDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(getLocale());
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-lobsterdex-page": HTMLAttributes<HTMLElement>;
    }
  }
}

export function LobsterdexPage() {
  let host!: HTMLElement;
  const cards = new Map<string, HTMLElement>();
  const context = useApplication();
  const branding = createMemo(() =>
    projectOwner(context.theme, (theme) => theme.branding, Object.is),
  );
  const entries = projectLobsterdex();
  const [copyFeedback, setCopyFeedback] = createSignal<LobsterdexCopyFeedback | null>(null);
  let disposed = false;
  let copyAttempt = 0;
  let copyResetTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  onSettled(() => () => {
    disposed = true;
    copyAttempt += 1;
    globalThis.clearTimeout(copyResetTimer);
  });
  onSettled(() => {
    const card = cards.get(location.hash);
    if (!card || !host.contains(card)) {
      return undefined;
    }
    const clearHighlight = (event: AnimationEvent) => {
      if (event.target !== card || event.animationName !== "lobsterdex-card-highlight") {
        return;
      }
      card.classList.remove("lobsterdex-page__card--highlight");
      stopHighlight();
    };
    const stopHighlight = listen(card, "animationend", { handleEvent: clearHighlight });
    card.classList.add("lobsterdex-page__card--highlight");
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => card.scrollIntoView({ block: "center" }));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      stopHighlight();
    };
  });

  async function copyLink(paletteId: LobsterPetPaletteId) {
    const attempt = ++copyAttempt;
    setCopyFeedback(null);
    globalThis.clearTimeout(copyResetTimer);
    copyResetTimer = undefined;
    const url = `${location.origin}${location.pathname}#lobsterdex-${paletteId}`;
    const copied = await copyToClipboard(url, () => !disposed && attempt === copyAttempt);
    if (disposed || attempt !== copyAttempt) {
      return;
    }
    setCopyFeedback({ paletteId, status: copied ? "copied" : "error" });
    copyResetTimer = globalThis.setTimeout(() => {
      setCopyFeedback(null);
      copyResetTimer = undefined;
    }, 1_500);
  }

  function LobsterdexView(props: { entries: ReturnType<typeof getLobsterdexEntries> }) {
    const seenCount = createMemo(
      () => LOBSTER_PET_PALETTES.filter((palette) => props.entries.has(palette.id)).length,
    );
    const countLabel = () =>
      t("quickSettings.appearance.lobsterdexSeen", {
        seen: String(seenCount()),
        total: String(LOBSTER_PET_PALETTES.length),
      });
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
          {copyFeedback()?.status === "copied" ? t("common.copied") : undefined}
        </span>
        {copyFeedback()?.status === "error" && (
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
                  ref={(element) => cards.set(`#lobsterdex-${palette.id}`, element)}
                  class={["lobsterdex-page__card", { "lobsterdex-page__card--unseen": !entry() }]}
                >
                  <button
                    type="button"
                    class="lobsterdex-page__copy-link"
                    aria-label={t("quickSettings.appearance.lobsterdexCardCopyLink")}
                    onClick={() => void copyLink(palette.id)}
                  >
                    <span aria-hidden="true">
                      <Icon
                        name={
                          copyFeedback()?.status === "copied" &&
                          copyFeedback()?.paletteId === palette.id
                            ? "check"
                            : "link"
                        }
                      />
                    </span>
                  </button>
                  <div
                    class={[
                      "lobsterdex-page__sprite",
                      "lobster-pet",
                      `lobster-pet--palette-${palette.id}`,
                      { "lobsterdex__mini--unseen": !entry() },
                    ]}
                    style={lobsterLookStyle(look)}
                  >
                    <LobsterSvg look={look} standalone />
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

  return (
    <openclaw-lobsterdex-page ref={(element) => (host = element)}>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <h1 class="page-title">{t("tabs.lobsterdex")}</h1>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace>
        {branding().read().lobsterdex ? (
          <LobsterdexView entries={entries.read()} />
        ) : (
          <section class="settings-section" role="status">
            <p>{t("quickSettings.appearance.lobsterdexThemeHidden")}</p>
            <a
              class="btn btn--sm"
              href={pathForRoute("appearance", context.basePath)}
              onClick={(event) =>
                handleNavigationClick(event, () => context.navigate("appearance"))
              }
            >
              {t("tabs.appearance")}
            </a>
          </section>
        )}
      </SettingsWorkspace>
    </openclaw-lobsterdex-page>
  );
}
