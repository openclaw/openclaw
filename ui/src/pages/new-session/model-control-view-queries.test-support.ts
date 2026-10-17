import { renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

export function managedModelControls() {
  const controls = new Set<NewSessionModelControl>();
  const track = (control: NewSessionModelControl) => {
    controls.add(control);
    return control;
  };
  return {
    track,
    make: (...args: ConstructorParameters<typeof NewSessionModelControl>) =>
      track(new NewSessionModelControl(...args)),
    reset: () => {
      controls.forEach((control) => control.reset());
      controls.clear();
    },
  };
}

export function modelOption(container: HTMLElement, model: string) {
  return controlElement(container, "model-option", model);
}

export function controlElement(container: HTMLElement, attribute: string, value?: string) {
  return container.querySelector<HTMLButtonElement>(
    `[data-chat-${attribute}${value === undefined ? "" : `="${value}"`}]`,
  );
}

export function controlQueries(...params: Parameters<typeof renderControl>) {
  const draw = () => renderControl(...params);
  const find = (attribute: string, value?: string) => controlElement(draw(), attribute, value);
  return { draw, find };
}
