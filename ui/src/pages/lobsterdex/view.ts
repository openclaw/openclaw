import { html, nothing } from "lit";
import type { ControlUiClawmoji } from "../../../../src/plugin-sdk/control-ui-lobsterdex.ts";
import { BUILTIN_CLAWMOJIS } from "../../app/lobsterdex-catalog.ts";
import { renderClawmoji } from "../../components/clawmoji.ts";
import { icons } from "../../components/icons.ts";
import { LOBSTER_PALETTE_LORE } from "../../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { i18n, t } from "../../i18n/index.ts";
// Page stars must override the shared mini-star rules loaded by lobster-pet-look.
import "../../styles/lobsterdex.css";

type LobsterdexViewEntry = {
  firstSeenAt: number | null;
  name: string | null;
  shinySeenAt: number | null;
};

type LobsterdexViewEntries = ReadonlyMap<string, LobsterdexViewEntry>;

export type LobsterdexCopyFeedback = {
  paletteId: string;
  status: "copied" | "error";
};

type LobsterdexViewProps = {
  catalog?: readonly ControlUiClawmoji[];
  copyFeedback?: LobsterdexCopyFeedback | null;
  onCopyLink?: (paletteId: string) => void;
};

function formatLobsterdexDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(i18n.getLocale());
}

export function renderLobsterdex(entries: LobsterdexViewEntries, props: LobsterdexViewProps = {}) {
  const seenCount = LOBSTER_PET_PALETTES.filter((palette) => entries.has(palette.id)).length;
  const complete = seenCount === LOBSTER_PET_PALETTES.length;
  const countLabel = t("quickSettings.appearance.lobsterdexSeen", {
    seen: String(seenCount),
    total: String(LOBSTER_PET_PALETTES.length),
  });
  return html`
    <section class="lobsterdex-page">
      <header
        class="lobsterdex-page__header ${complete ? "lobsterdex-page__header--complete" : ""}"
      >
        <div>
          <h2>${t("tabs.lobsterdex")}</h2>
          <p>${t("subtitles.lobsterdex")}</p>
        </div>
        <span class="lobsterdex-page__count">${countLabel}</span>
      </header>
      <span class="sr-only" role="status">
        ${props.copyFeedback?.status === "copied" ? t("common.copied") : nothing}
      </span>
      ${
        props.copyFeedback?.status === "error"
          ? html`<div class="callout danger" role="alert">${t("common.copyFailed")}</div>`
          : nothing
      }
      <section class="lobsterdex-page__grid" aria-label=${countLabel}>
        ${BUILTIN_CLAWMOJIS.map((palette) => {
          const entry = entries.get(palette.id);
          const seen = entry !== undefined;
          const name = seen ? (entry.name ?? palette.name) : "?";
          const lore =
            LOBSTER_PALETTE_LORE[
              LOBSTER_PET_PALETTES.find((candidate) => candidate.id === palette.id)!.id
            ];
          const firstSeen =
            seen && entry.firstSeenAt !== null
              ? t("quickSettings.appearance.lobsterdexCardFirstVisited", {
                  date: formatLobsterdexDate(entry.firstSeenAt),
                })
              : null;
          const shinySeen =
            entry?.shinySeenAt != null
              ? t("quickSettings.appearance.lobsterdexCardShinySeen", {
                  date: formatLobsterdexDate(entry.shinySeenAt),
                })
              : null;
          return html`
            <article
              id="lobsterdex-${palette.id}"
              class="lobsterdex-page__card ${seen ? "" : "lobsterdex-page__card--unseen"}"
            >
              <button
                type="button"
                class="lobsterdex-page__copy-link"
                aria-label=${t("quickSettings.appearance.lobsterdexCardCopyLink")}
                @click=${() => props.onCopyLink?.(palette.id)}
              >
                <span aria-hidden="true"
                  >${
                    props.copyFeedback?.status === "copied" &&
                    props.copyFeedback.paletteId === palette.id
                      ? icons.check
                      : icons.link
                  }</span
                >
              </button>
              <div
                class="lobsterdex-page__sprite lobster-pet lobster-pet--palette-${palette.id} ${
                  seen ? "" : "lobsterdex__mini--unseen"
                }"
              >
                ${renderClawmoji({ entry: palette, size: 90, label: name })}
                ${
                  entry?.shinySeenAt != null
                    ? html`<span
                        class="lobsterdex__mini-star lobsterdex-page__star"
                        aria-hidden="true"
                        >✦</span
                      >`
                    : nothing
                }
              </div>
              <h3>${name}</h3>
              <p class="lobsterdex-page__lore">${seen ? lore.flavor : lore.hint}</p>
              <div class="lobsterdex-page__dates">
                ${
                  firstSeen
                    ? html`<p class="lobsterdex-page__date"><time>${firstSeen}</time></p>`
                    : nothing
                }
                ${
                  shinySeen
                    ? html`<p class="lobsterdex-page__date"><time>${shinySeen}</time></p>`
                    : nothing
                }
              </div>
            </article>
          `;
        })}
      </section>
      ${renderPackCollections(entries, props)}
    </section>
  `;
}

function renderPackCollections(entries: LobsterdexViewEntries, props: LobsterdexViewProps) {
  const packs = new Map<string, { name: string; characters: ControlUiClawmoji[] }>();
  for (const character of props.catalog ?? []) {
    if (character.source !== "plugin") {
      continue;
    }
    const id = `${character.pluginId}/${character.packId}`;
    const pack = packs.get(id) ?? { name: character.packName, characters: [] };
    pack.characters.push(character);
    packs.set(id, pack);
  }
  const available = new Set((props.catalog ?? BUILTIN_CLAWMOJIS).map((entry) => entry.id));
  const unavailable = [...entries].filter(([id]) => id.includes("/") && !available.has(id));
  return html`
    ${[...packs].map(
      ([id, pack]) => html` <section aria-label=${pack.name} data-lobster-pack=${id}>
        <header class="lobsterdex-page__header">
          <h2>${pack.name}</h2>
          <span
            >${t("quickSettings.appearance.lobsterdexSeen", {
              seen: String(pack.characters.filter((entry) => entries.has(entry.id)).length),
              total: String(pack.characters.length),
            })}</span
          >
        </header>
        <div class="lobsterdex-page__grid">
          ${pack.characters.map((character) => {
            const visit = entries.get(character.id);
            return html`<article id=${`lobsterdex-${character.id}`} class="lobsterdex-page__card">
              <button
                type="button"
                class="lobsterdex-page__copy-link"
                aria-label=${t("quickSettings.appearance.lobsterdexCardCopyLink")}
                @click=${() => props.onCopyLink?.(character.id)}
              >
                ${icons.link}
              </button>
              <div class="lobsterdex-page__sprite">
                ${renderClawmoji({ entry: character, size: 90, label: character.name })}
              </div>
              <h3>${visit?.name ?? character.name}</h3>
              <p class="lobsterdex-page__lore">${character.description ?? ""}</p>
              <p>
                ${visit?.firstSeenAt != null ? t("quickSettings.appearance.lobsterdexCardFirstVisited", { date: formatLobsterdexDate(visit.firstSeenAt) }) : t("quickSettings.appearance.lobsterdexPackPreview")}
              </p>
            </article>`;
          })}
        </div>
      </section>`,
    )}
    ${
      unavailable.length
        ? html`<section>
            <h2>${t("quickSettings.appearance.lobsterdexUnavailable")}</h2>
            ${unavailable.map(([id, visit]) => html`<p>${visit.name ?? id}</p>`)}
          </section>`
        : nothing
    }
  `;
}
