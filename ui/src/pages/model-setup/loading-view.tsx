import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderNativeModelSetupLoading } from "./native-model-setup.tsx";

registerModelSetupEnglish();

function renderLoadingSection(
  title: string,
  params: { rows?: number; intro?: string; className?: string; status?: string } = {},
) {
  return (
    <section class={`settings-section ${params.className ?? ""}`.trim()}>
      <div class="settings-section__header">
        <h2>{title}</h2>
      </div>
      {params.intro ? (
        <>
          {" "}
          <p class="muted model-setup__loading-intro">{params.intro}</p>{" "}
        </>
      ) : undefined}
      <div class="model-setup__rows">
        {Array.from({ length: params.rows ?? 1 }, (_, index) => (
          <div class="model-setup__row model-setup__loading-row">
            <span class="model-setup__loading-icon skeleton" />
            <span class="model-setup__loading-copy">
              {index === 0 && params.status ? (
                <>
                  {" "}
                  <span class="model-setup__loading-status">{params.status}</span>{" "}
                </>
              ) : (
                <>
                  {" "}
                  <span class="skeleton skeleton-line skeleton-line--medium" />{" "}
                </>
              )}
              <span class="skeleton skeleton-line skeleton-line--long" />
            </span>
            <span class="model-setup__loading-action skeleton" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function renderModelSetupLoading(modelConfigured: boolean) {
  return (
    <div
      class="model-setup__loading"
      role="status"
      aria-busy="true"
      aria-label={t("modelSetup.loading")}
    >
      <div class="model-setup__loading-sections" aria-hidden="true">
        {modelConfigured
          ? renderLoadingSection(t("modelSetup.verify.title"), {
              className: "model-setup__loading-section--selected",
              status: t("modelSetup.loading"),
            })
          : undefined}
        {renderNativeModelSetupLoading()}
        {renderLoadingSection(t("modelSetup.candidates.title"), {
          className: "model-setup__loading-section--candidates",
          status: modelConfigured ? undefined : t("modelSetup.loading"),
        })}
        {renderLoadingSection(t("modelSetup.prepare.title"), {
          intro: t("modelSetup.prepare.intro"),
          rows: 2,
        })}
        {renderLoadingSection(t("modelSetup.signIn.title"), {
          className: "model-setup__loading-section--sign-in",
        })}
        {renderLoadingSection(t("modelSetup.manual.title"))}
      </div>
    </div>
  );
}
