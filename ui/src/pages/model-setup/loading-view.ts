import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";

registerModelSetupEnglish();

function renderLoadingSection(params: {
  title: string;
  rows?: number;
  intro?: string;
  className?: string;
  status?: string;
}) {
  return html`
    <section class=${`settings-section ${params.className ?? ""}`.trim()}>
      <div class="settings-section__header"><h2>${params.title}</h2></div>
      ${params.intro ? html`<p class="muted">${params.intro}</p>` : nothing}
      <div class="model-setup__rows">
        ${Array.from(
          { length: params.rows ?? 1 },
          (_, index) => html`
            <div class="model-setup__row model-setup__loading-row">
              <span class="model-setup__loading-icon skeleton"></span>
              <span class="model-setup__loading-copy">
                ${
                  index === 0 && params.status
                    ? html`<span class="model-setup__loading-status">${params.status}</span>`
                    : html`<span class="skeleton skeleton-line skeleton-line--medium"></span>`
                }
                <span class="skeleton skeleton-line skeleton-line--long"></span>
              </span>
              <span class="model-setup__loading-action skeleton"></span>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

export function renderModelSetupLoading(modelConfigured: boolean) {
  return html`
    <div
      class="model-setup__loading"
      role="status"
      aria-busy="true"
      aria-label=${t("modelSetup.loading")}
    >
      <div class="model-setup__loading-sections" aria-hidden="true">
        ${
          modelConfigured
            ? renderLoadingSection({
                title: t("modelSetup.verify.title"),
                className: "model-setup__loading-section--selected",
                status: t("modelSetup.loading"),
              })
            : nothing
        }
        ${renderLoadingSection({
          title: t("modelSetup.candidates.title"),
          className: "model-setup__loading-section--candidates",
          status: modelConfigured ? undefined : t("modelSetup.loading"),
        })}
        ${renderLoadingSection({
          title: t("modelSetup.prepare.title"),
          intro: t("modelSetup.prepare.intro"),
          rows: 2,
        })}
        ${renderLoadingSection({
          title: t("modelSetup.signIn.title"),
          className: "model-setup__loading-section--sign-in",
        })}
        ${renderLoadingSection({ title: t("modelSetup.manual.title") })}
      </div>
    </div>
  `;
}
