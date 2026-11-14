import { For, Show, createMemo, createStore } from "solid-js";
import type { McpAppSettings } from "../../../../src/shared/mcp-app-extensions.js";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
import { t } from "../../lib/reactive/i18n.ts";

registerMcpAppEnglish();

export function McpAppSettingsForm(props: {
  settings: McpAppSettings;
  busy: boolean;
  onSave: (changes: McpAppSettings["values"]) => void;
  onTool: (name: string) => void;
}) {
  // Accepted settings replace the local draft; busy/notice updates preserve edits.
  const [values, setValues] = createStore(() => ({ ...props.settings.values }), {});
  const changes = createMemo(() =>
    Object.fromEntries(
      Object.entries(values).filter(([key, value]) => props.settings.values[key] !== value),
    ),
  );
  const hasChanges = () => Object.keys(changes()).length > 0;
  const change = (key: string, value: string | number | boolean) =>
    setValues((draft) => {
      draft[key] = value;
    });
  const rendered = createMemo(
    () =>
      new Set(
        props.settings.layout?.flatMap((group) =>
          group.items.flatMap((item) => (item.kind === "property" ? [item.property] : [])),
        ),
      ),
  );
  const field = (key: string) => (
    <Show when={props.settings.schema.properties[key]} keyed>
      {(schema) => {
        const value = () => values[key];
        const required = () => props.settings.schema.required?.includes(key) ?? false;
        return (
          <label class="mcp-app-settings__field">
            <span>{schema.title}</span>
            <Show when={schema.description}>
              <small class="muted">{schema.description}</small>
            </Show>
            {schema.type === "boolean" ? (
              <input
                type="checkbox"
                checked={value() === true}
                disabled={props.busy}
                onChange={(event) => change(key, event.currentTarget.checked)}
              />
            ) : schema.type === "string" && schema.enum ? (
              <select
                value={String(value() ?? "")}
                required={required()}
                disabled={props.busy}
                onChange={(event) => change(key, event.currentTarget.value)}
              >
                <For each={schema.enum}>
                  {(option) => (
                    <option value={option} selected={option === value()}>
                      {option}
                    </option>
                  )}
                </For>
              </select>
            ) : (
              <input
                type={schema.type === "string" ? "text" : "number"}
                value={String(value() ?? "")}
                required={required()}
                disabled={props.busy}
                minlength={schema.type === "string" ? schema.minLength : undefined}
                maxlength={schema.type === "string" ? schema.maxLength : undefined}
                pattern={schema.type === "string" ? schema.pattern : undefined}
                min={schema.type !== "string" ? schema.minimum : undefined}
                max={schema.type !== "string" ? schema.maximum : undefined}
                step={
                  schema.type === "string"
                    ? undefined
                    : (schema.multipleOf ?? (schema.type === "integer" ? 1 : "any"))
                }
                onInput={(event) => {
                  const input = event.currentTarget;
                  if (schema.type === "string") {
                    change(key, input.value);
                  } else if (Number.isFinite(input.valueAsNumber)) {
                    change(key, input.valueAsNumber);
                  }
                }}
              />
            )}
          </label>
        );
      }}
    </Show>
  );
  return (
    <form
      class="mcp-app-settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges() && event.currentTarget.reportValidity()) {
          props.onSave(changes());
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
