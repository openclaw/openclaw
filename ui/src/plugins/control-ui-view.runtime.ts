import { render } from "lit";

/** Preserve the unchanged plugin SDK's opaque templates and event receiver. */
export function renderPluginTemplate(template: unknown, target: HTMLElement, host?: object): void {
  render(template, target, { host });
}
