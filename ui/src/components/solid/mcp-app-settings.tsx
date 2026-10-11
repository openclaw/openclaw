import { For, Show } from "solid-js";
import type { McpAppSettings } from "../../../../src/shared/mcp-app-extensions.js";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
import { t } from "../../lib/reactive/i18n.ts";

registerMcpAppEnglish();

export type McpAppSettingsView = {
  settings: McpAppSettings;
  values: McpAppSettings["values"];
  busy: boolean;
  onChange: (key: string, value: string | number | boolean) => void;
  onSave: () => void;
  onTool: (name: string) => void;
};

export function McpAppSettingsForm(props: McpAppSettingsView) {
  const hasChanges = () =>
    Object.entries(props.values).some(([key, value]) => props.settings.values[key] !== value);
  const rendered = () =>
    new Set(
      props.settings.layout?.flatMap((group) =>
        group.items.flatMap((item) => (item.kind === "property" ? [item.property] : [])),
      ),
    );
  const field = (key: string) => {
    const schema = () => props.settings.schema.properties[key];
    const stringSchema = () => {
      const current = schema();
      return current.type === "string" ? current : undefined;
    };
    const numberSchema = () => {
      const current = schema();
      return current.type === "number" || current.type === "integer" ? current : undefined;
    };
    const value = () => props.values[key];
    const required = () => props.settings.schema.required?.includes(key) ?? false;
    return (
      <Show when={schema()}>
        {(current) => (
          <label class="mcp-app-settings__field">
            <span>{current().title}</span>
            <Show when={schema().description}>
              <small class="muted">{schema().description}</small>
            </Show>
            {schema().type === "boolean" ? (
              <input
                type="checkbox"
                checked={value() === true}
                disabled={props.busy}
                onChange={(event) => props.onChange(key, event.currentTarget.checked)}
              />
            ) : stringSchema()?.enum ? (
              <select
                value={String(value() ?? "")}
                required={required()}
                disabled={props.busy}
                onChange={(event) => props.onChange(key, event.currentTarget.value)}
              >
                <For each={stringSchema()?.enum}>
                  {(option) => (
                    <option value={option} selected={option === value()}>
                      {option}
                    </option>
                  )}
                </For>
              </select>
            ) : (
              <Show when={schema().type === "string" ? "text" : "number"} keyed>
                {(type) => (
                  <input
                    type={type}
                    value={String(value() ?? "")}
                    required={required()}
                    disabled={props.busy}
                    minLength={stringSchema()?.minLength}
                    maxLength={stringSchema()?.maxLength}
                    pattern={stringSchema()?.pattern}
                    min={numberSchema()?.minimum}
                    max={numberSchema()?.maximum}
                    step={
                      schema().type === "string"
                        ? undefined
                        : (numberSchema()?.multipleOf ?? (schema().type === "integer" ? 1 : "any"))
                    }
                    onInput={(event) => {
                      const input = event.currentTarget;
                      if (schema().type === "string") {
                        props.onChange(key, input.value);
                      } else if (Number.isFinite(input.valueAsNumber)) {
                        props.onChange(key, input.valueAsNumber);
                      }
                    }}
                  />
                )}
              </Show>
            )}
          </label>
        )}
      </Show>
    );
  };
  return (
    <form
      class="mcp-app-settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges() && event.currentTarget.reportValidity()) {
          props.onSave();
        }
      }}
    >
      <p class="muted">{t("mcpApp.settingsDescription")}</p>
      <For each={props.settings.layout}>
        {(group) => (
          <fieldset disabled={props.busy}>
            <legend>{group.title}</legend>
            <For each={group.items}>
              {(item) =>
                item.kind === "property" ? (
                  field(item.property)
                ) : (
                  <div class="mcp-app-settings__field">
                    <button type="button" class="btn" onClick={() => props.onTool(item.tool)}>
                      {item.title}
                    </button>
                    <Show when={item.description}>
                      <small>{item.description}</small>
                    </Show>
                  </div>
                )
              }
            </For>
          </fieldset>
        )}
      </For>
      <For
        each={Object.keys(props.settings.schema.properties).filter((key) => !rendered().has(key))}
      >
        {field}
      </For>
      <button type="submit" class="btn primary" disabled={props.busy || !hasChanges()}>
        {t("mcpApp.save")}
      </button>
    </form>
  );
}
