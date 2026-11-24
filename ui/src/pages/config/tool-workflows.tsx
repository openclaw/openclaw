import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "./settings-select-row.tsx";

registerEnglishCatalog(registerSettingsEnglish);

/** Ordinary config controls; the existing form owner admits and saves every edit. */
export function ToolWorkflows(props: {
  config: Record<string, unknown> | null;
  disabled: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}) {
  const tools = () => asNullableRecord(props.config?.tools);
  const codeMode = () => tools()?.codeMode;
  const toolSearch = () => tools()?.toolSearch;
  const codeModeEnabled = () => {
    const raw = codeMode();
    return (
      raw === undefined ||
      raw === true ||
      raw === "auto" ||
      (isRecord(raw) && (raw.enabled === true || raw.enabled === "auto"))
    );
  };
  const toolSearchEnabled = () => {
    const raw = toolSearch();
    return (
      raw === undefined ||
      raw === true ||
      (isRecord(raw) && (raw.enabled ?? Object.keys(raw).some((key) => key !== "enabled")) === true)
    );
  };
  return (
    <>
      <SettingsToggleRow
        title={t("configView.toolWorkflows.codeMode")}
        description={t("configView.toolWorkflows.codeModeDescription")}
        checked={codeModeEnabled()}
        disabled={props.disabled}
        onChange={(enabled) =>
          props.onPatch(["tools", "codeMode"], {
            ...asNullableRecord(codeMode()),
            enabled: enabled ? "auto" : false,
          })
        }
      />
      <SettingsSelectRow
        nested
        title={t("configView.toolWorkflows.executor")}
        description={t("configView.toolWorkflows.executorDescription")}
        value={asNullableRecord(codeMode())?.executor === "quickjs" ? "quickjs" : "node"}
        disabled={props.disabled}
        options={[
          { value: "node", label: t("configView.toolWorkflows.executorNode") },
          { value: "quickjs", label: t("configView.toolWorkflows.executorQuickjs") },
        ]}
        onChange={(executor) => {
          const raw = codeMode();
          props.onPatch(["tools", "codeMode"], {
            ...(isRecord(raw) ? raw : { enabled: raw ?? "auto" }),
            executor,
          });
        }}
      />
      <SettingsToggleRow
        title={t("configView.toolWorkflows.toolSearch")}
        description={t("configView.toolWorkflows.toolSearchDescription")}
        checked={toolSearchEnabled()}
        disabled={props.disabled}
        onChange={(enabled) =>
          props.onPatch(["tools", "toolSearch"], {
            ...asNullableRecord(toolSearch()),
            enabled,
          })
        }
      />
    </>
  );
}
