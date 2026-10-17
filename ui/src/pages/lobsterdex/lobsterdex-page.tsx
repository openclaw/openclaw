import { createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import type { LobsterPetPaletteId } from "../../components/lobster-pet-contract.ts";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectLobsterdex } from "../../lib/reactive/events-browser.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { LobsterdexView, type LobsterdexCopyFeedback } from "./view.tsx";
import "../../styles/settings.css";

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
  onCleanup(() => {
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

  return (
    <openclaw-lobsterdex-page ref={(element) => (host = element)}>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <h1 class="page-title">{t("tabs.lobsterdex")}</h1>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace>
        {branding().read().lobsterdex ? (
          <LobsterdexView
            entries={entries.read()}
            copyFeedback={copyFeedback()}
            onCardRef={(id, element) => cards.set(`#lobsterdex-${id}`, element)}
            onCopyLink={(paletteId) => void copyLink(paletteId)}
          />
        ) : (
          <section class="settings-section" role="status">
            <p>{t("quickSettings.appearance.lobsterdexThemeHidden")}</p>
            <a
              class="btn btn--sm"
              href={pathForRoute("appearance", context.basePath)}
              onClick={(event) => {
                if (shouldHandleNavigationClick(event)) {
                  event.preventDefault();
                  context.navigate("appearance");
                }
              }}
            >
              {t("tabs.appearance")}
            </a>
          </section>
        )}
      </SettingsWorkspace>
    </openclaw-lobsterdex-page>
  );
}
