import { createEffect, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import type { LobsterPetPaletteId } from "../../components/lobster-pet-contract.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectLobsterdex } from "../../lib/reactive/events-browser.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { PageLayout } from "../page-layout.tsx";
import { LobsterdexView, type LobsterdexCopyFeedback } from "./view.tsx";
import "../../styles/settings.css";

function LobsterdexPageContent(props: { host: HTMLElement }) {
  const host = untrack(() => props.host);
  const context = useApplication();
  const branding = projectSource(
    untrack(() => context.theme),
    {
      read: (theme) => theme.branding,
      subscribe: (theme, notify) => theme.subscribe(notify),
      equality: Object.is,
    },
  );
  createEffect(
    () => context.theme,
    (source) => branding.replaceSource(source),
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
    const prefix = "#lobsterdex-";
    if (!location.hash.startsWith(prefix)) {
      return undefined;
    }
    const palette = LOBSTER_PET_PALETTES.find(
      (entry) => entry.id === location.hash.slice(prefix.length),
    );
    const card = palette ? host.querySelector<HTMLElement>(`#lobsterdex-${palette.id}`) : null;
    if (!card) {
      return undefined;
    }
    const clearHighlight = (event: AnimationEvent) => {
      if (event.target !== card || event.animationName !== "lobsterdex-card-highlight") {
        return;
      }
      card.classList.remove("lobsterdex-page__card--highlight");
      card.removeEventListener("animationend", clearHighlight);
    };
    card.addEventListener("animationend", clearHighlight);
    card.classList.add("lobsterdex-page__card--highlight");
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => card.scrollIntoView({ block: "center" }));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      card.removeEventListener("animationend", clearHighlight);
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
    <>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <h1 class="page-title">{t("tabs.lobsterdex")}</h1>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace>
        {branding.read().lobsterdex ? (
          <LobsterdexView
            entries={entries.read()}
            copyFeedback={copyFeedback()}
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
    </>
  );
}

export const LobsterdexPage = defineSolidBridge(
  "openclaw-lobsterdex-page",
  (_props, host) => (
    <PageLayout host={host}>
      <LobsterdexPageContent host={host} />
    </PageLayout>
  ),
  { properties: {} },
);
