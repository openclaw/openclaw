import { For, Show } from "solid-js";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerTemplatesEnglish } from "../../i18n/locales/en-templates.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { TemplateCatalogDetail } from "./templates-catalog-client.ts";
import "./template-access-section.css";

registerEnglishCatalog(registerTemplatesEnglish);

const toolLists: Array<"allow" | "alsoAllow" | "deny"> = ["allow", "alsoAllow", "deny"];

export function TemplateAccessSection(props: { access: TemplateCatalogDetail["access"] }) {
  const hasDeclarations = () => {
    const sandbox = props.access?.sandbox;
    const tools = props.access?.tools;
    return [
      sandbox?.mode,
      sandbox?.scope,
      sandbox?.workspaceAccess,
      tools?.profile,
      tools?.allow,
      tools?.alsoAllow,
      tools?.deny,
      tools?.fs?.workspaceOnly,
    ].some((value) => value !== undefined);
  };
  const rows = () => {
    const sandbox = props.access?.sandbox;
    const tools = props.access?.tools;
    const unspecified = t("templatesCatalog.access.unspecified");
    const entries = [
      {
        id: "sandbox",
        title: t("templatesCatalog.access.sandbox"),
        description:
          sandbox?.mode === undefined
            ? unspecified
            : t(`templatesCatalog.access.mode.${sandbox.mode}`),
      },
      {
        id: "toolProfile",
        title: t("templatesCatalog.access.toolProfile"),
        description: tools?.profile ?? unspecified,
      },
      {
        id: "filesystem",
        title: t("templatesCatalog.access.filesystem"),
        description:
          tools?.fs?.workspaceOnly === undefined
            ? unspecified
            : t(
                tools.fs.workspaceOnly
                  ? "templatesCatalog.access.workspaceOnly"
                  : "templatesCatalog.access.workspaceOnlyOff",
              ),
      },
    ];
    if (sandbox?.scope !== undefined) {
      entries.push({
        id: "scope",
        title: t("templatesCatalog.access.scope"),
        description: t(`templatesCatalog.access.scopes.${sandbox.scope}`),
      });
    }
    if (sandbox?.workspaceAccess !== undefined) {
      entries.push({
        id: "workspaceAccess",
        title: t("templatesCatalog.access.workspaceAccess"),
        description: t(`templatesCatalog.access.workspace.${sandbox.workspaceAccess}`),
      });
    }
    for (const key of toolLists) {
      const names = tools?.[key];
      if (names !== undefined) {
        entries.push({
          id: key,
          title: t(`templatesCatalog.access.${key}`),
          description:
            names.toSorted((left, right) => left.localeCompare(right)).join(", ") ||
            t("templatesCatalog.noneIncluded"),
        });
      }
    }
    return entries.toSorted((left, right) => left.title.localeCompare(right.title));
  };
  const toolRuleSummary = () =>
    toolLists
      .flatMap((key) => {
        const entries = props.access?.tools?.[key];
        return entries === undefined
          ? []
          : [t(`templatesCatalog.access.${key}Count`, { count: String(entries.length) })];
      })
      .join(" · ");
  return (
    <Show when={hasDeclarations()}>
      <div class="template-access-section">
        <SettingsSection
          title={t("templatesCatalog.access.title")}
          description={t("templatesCatalog.access.description")}
          carapace
        >
          <dl
            class="template-execution-summary"
            aria-label={t("templatesCatalog.access.summaryLabel")}
          >
            <div>
              <dt>{t("templatesCatalog.access.sandbox")}</dt>
              <dd>
                {props.access?.sandbox?.mode === undefined
                  ? t("templatesCatalog.access.unspecified")
                  : t(`templatesCatalog.access.mode.${props.access.sandbox.mode}`)}
              </dd>
            </div>
            <div>
              <dt>{t("templatesCatalog.access.fileAccess")}</dt>
              <dd>
                {props.access?.tools?.fs?.workspaceOnly === undefined
                  ? t("templatesCatalog.access.unspecified")
                  : t(
                      props.access.tools.fs.workspaceOnly
                        ? "templatesCatalog.access.confinedTools"
                        : "templatesCatalog.access.workspaceOnlyOff",
                    )}
                <Show when={props.access?.sandbox?.workspaceAccess}>
                  <span class="template-execution-summary__detail">
                    {t("templatesCatalog.access.sandboxWorkspace", {
                      access: t(
                        `templatesCatalog.access.workspace.${props.access?.sandbox?.workspaceAccess}`,
                      ),
                    })}
                  </span>
                </Show>
              </dd>
            </div>
            <div>
              <dt>{t("templatesCatalog.access.toolPolicy")}</dt>
              <dd>
                {props.access?.tools?.profile ??
                  t(
                    props.access?.tools?.allow === undefined
                      ? "templatesCatalog.access.unspecified"
                      : "templatesCatalog.access.allow",
                  )}
                <Show when={toolRuleSummary()}>
                  <span class="template-execution-summary__detail">{toolRuleSummary()}</span>
                </Show>
              </dd>
            </div>
          </dl>
          <details
            class="template-execution-details"
            aria-label={t("templatesCatalog.access.detailsLabel")}
          >
            <summary>{t("templatesCatalog.access.viewDetails")}</summary>
            <For each={rows()} keyed={(row) => row.id}>
              {(row) => (
                <SettingsRow title={row().title} description={row().description} carapace />
              )}
            </For>
          </details>
        </SettingsSection>
      </div>
    </Show>
  );
}
