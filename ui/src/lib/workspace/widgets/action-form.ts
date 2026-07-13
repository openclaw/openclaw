import { html, type TemplateResult } from "lit";
import type { WorkspaceWidget } from "../types.ts";
import { isRecord, widgetProps, type BuiltinWidgetContext } from "./types.ts";

type ActionFormField = {
  name: string;
  label: string;
  type: "text" | "number" | "select";
  options?: string[];
  maxLength?: number;
};
type ActionFormModel = { template: string; fields: ActionFormField[]; buttonLabel: string };
const ACTION_FORM_DEFAULT_MAX_LENGTH = 200;
const SLOT_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

function mapField(value: unknown): ActionFormField | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.label !== "string") {
    return null;
  }
  if (value.type !== "text" && value.type !== "number" && value.type !== "select") {
    return null;
  }
  const options =
    value.type === "select" && Array.isArray(value.options)
      ? value.options.filter((option): option is string => typeof option === "string")
      : undefined;
  if (value.type === "select" && !options?.length) {
    return null;
  }
  const maxLength =
    typeof value.maxLength === "number" && Number.isInteger(value.maxLength) && value.maxLength > 0
      ? value.maxLength
      : undefined;
  return {
    name: value.name,
    label: value.label,
    type: value.type,
    ...(options ? { options } : {}),
    ...(maxLength ? { maxLength } : {}),
  };
}

function mapActionForm(widget: WorkspaceWidget): ActionFormModel {
  const props = widgetProps(widget);
  return {
    template: typeof props.template === "string" ? props.template : "",
    fields: Array.isArray(props.fields)
      ? props.fields.map(mapField).filter((field): field is ActionFormField => field !== null)
      : [],
    buttonLabel: typeof props.buttonLabel === "string" ? props.buttonLabel : "Send",
  };
}

function coerceFieldValue(field: ActionFormField, raw: string): string {
  const cap = field.maxLength ?? ACTION_FORM_DEFAULT_MAX_LENGTH;
  if (field.type === "number") {
    const value = raw.trim();
    return value && Number.isFinite(Number(value)) ? value.slice(0, cap) : "";
  }
  if (field.type === "select") {
    return field.options?.includes(raw) ? raw : "";
  }
  return raw.slice(0, cap);
}

function buildActionFormPrompt(model: ActionFormModel, values: Record<string, string>): string {
  const fields = new Map(model.fields.map((field) => [field.name, field]));
  return model.template.replace(SLOT_PATTERN, (match, name: string) => {
    const field = fields.get(name);
    return field ? coerceFieldValue(field, values[name] ?? "") : match;
  });
}

export function renderActionForm(
  widget: WorkspaceWidget,
  _value: unknown,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  const model = mapActionForm(widget);
  const submit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values: Record<string, string> = {};
    for (const field of model.fields) {
      const control = form.elements.namedItem(field.name);
      values[field.name] = control && "value" in control ? control.value : "";
    }
    const text = buildActionFormPrompt(model, values);
    if (text.trim()) {
      void ctx
        .dispatchPrompt?.({ widgetKey: `builtin:action-form:${widget.id}`, text })
        .then((result) => {
          if (result === "sent") {
            form.reset();
          }
        });
    }
  };
  return html`<form
    class="workspace-action-form"
    data-test-id="workspace-action-form"
    @submit=${submit}
  >
    ${model.fields.map(
      (field) =>
        html`<label
          >${field.label}${field.type === "select"
            ? html`<select name=${field.name}>
                ${field.options?.map((option) => html`<option value=${option}>${option}</option>`)}
              </select>`
            : html`<input
                name=${field.name}
                type=${field.type}
                maxlength=${field.maxLength ?? ACTION_FORM_DEFAULT_MAX_LENGTH}
              />`}</label
        >`,
    )}
    <button class="btn btn--small btn--primary" type="submit">${model.buttonLabel}</button>
  </form>`;
}
