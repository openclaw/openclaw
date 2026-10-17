import { renderControl } from "./model-control.test-support.ts";

export function modelOption(container: HTMLElement, model: string) {
  return container.querySelector<HTMLButtonElement>(`[data-chat-model-option="${model}"]`);
}

export function controlQueries(...params: Parameters<typeof renderControl>) {
  const draw = () => renderControl(...params);
  const find = (selector: string) => draw().querySelector<HTMLButtonElement>(selector);
  return { draw, find };
}
