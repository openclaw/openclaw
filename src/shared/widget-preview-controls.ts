export type WidgetPreviewControl = {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
};

/**
 * Read only bounded local preview controls, never widget-authored HTML or capabilities.
 * Keep this function self-contained: the document wrapper embeds its JavaScript
 * source so the sandbox runtime and host validate exactly the same contract.
 */
export function readWidgetPreviewControls(value: unknown): WidgetPreviewControl[] | undefined {
  if (!Array.isArray(value) || value.length > 4) {
    return undefined;
  }
  const controls: WidgetPreviewControl[] = [];
  const ids = new Set<string>();
  for (const control of value) {
    if (
      !control ||
      typeof control.id !== "string" ||
      !control.id.trim() ||
      control.id.length > 40 ||
      ids.has(control.id) ||
      typeof control.label !== "string" ||
      !control.label.trim() ||
      control.label.length > 80 ||
      typeof control.value !== "string" ||
      !Array.isArray(control.options) ||
      control.options.length < 1 ||
      control.options.length > 8
    ) {
      return undefined;
    }
    const options: WidgetPreviewControl["options"] = [];
    const values = new Set<string>();
    for (const option of control.options) {
      if (
        !option ||
        typeof option.value !== "string" ||
        option.value.length > 40 ||
        values.has(option.value) ||
        typeof option.label !== "string" ||
        !option.label.trim() ||
        option.label.length > 80
      ) {
        return undefined;
      }
      values.add(option.value);
      options.push({ value: option.value, label: option.label });
    }
    if (!values.has(control.value)) {
      return undefined;
    }
    ids.add(control.id);
    controls.push({ id: control.id, label: control.label, value: control.value, options });
  }
  return controls;
}
