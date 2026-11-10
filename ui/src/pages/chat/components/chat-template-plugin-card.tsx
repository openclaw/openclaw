import { Show } from "solid-js";
import { pluginCatalogIdFromRouteSuffix } from "../../../../../packages/plugin-package-contract/src/catalog-route.ts";
import type { TemplatePluginInstallNotice } from "../../../../../src/shared/template-install-notice.js";
import { pathForPluginCatalogEntry } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { useApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/chat/clawhub-card.css";

/** Installer receipt, not a recommendation: no discovery reads or install actions. */
export function ChatTemplatePluginCard(props: { notice: TemplatePluginInstallNotice }) {
  const context = useApplication();
  const catalogId = () =>
    pluginCatalogIdFromRouteSuffix(props.notice.packageName.replace(/^@/, "")) ??
    props.notice.pluginId;
  return (
    <openclaw-chat-clawhub-card data-template-plugin-id={props.notice.pluginId}>
      <div class="card chat-clawhub-card">
        <button
          class="chat-clawhub-card__listing"
          type="button"
          onClick={() =>
            context.navigate("plugins", {
              pathname: pathForPluginCatalogEntry(catalogId(), context.basePath),
            })
          }
        >
          <span class="chat-clawhub-card__icon" aria-hidden="true">
            <Icon name="plug" />
          </span>
          <span class="chat-clawhub-card__identity">
            <span class="card-title chat-clawhub-card__name">
              <span>{props.notice.displayName}</span>
              <Show when={props.notice.official === true}>
                <span
                  class="plugin-official-badge"
                  role="img"
                  aria-label={t("pluginsPage.official")}
                  title={t("pluginsPage.official")}
                >
                  <Icon name="badgeCheck" />
                </span>
              </Show>
            </span>
            <span class="card-sub">{props.notice.packageName}</span>
            <Show when={props.notice.status === "error" && props.notice.error}>
              {(error) => <span class="card-sub">{error()}</span>}
            </Show>
          </span>
        </button>
        <div class="chat-clawhub-card__actions">
          <span
            class={[
              "chip",
              "chat-clawhub-card__installed",
              {
                "chip-ok": props.notice.status === "installed",
                "chip-danger": props.notice.status === "error",
              },
            ]}
          >
            <Icon name={props.notice.status === "installed" ? "check" : "circleAlert"} />
            <span>
              {props.notice.status === "installed"
                ? t("pluginsPage.installed")
                : t("common.failed")}
            </span>
          </span>
        </div>
      </div>
    </openclaw-chat-clawhub-card>
  );
}
