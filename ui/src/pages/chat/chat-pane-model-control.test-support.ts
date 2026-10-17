import { onTestFinished } from "vitest";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { ChatPaneModelControl } from "./chat-pane-model-control.tsx";

type ModelControlProps = Parameters<typeof ChatPaneModelControl>[0];
const modelControlViews = new WeakMap<
  HTMLElement,
  { update: (props: ModelControlProps) => void }
>();

export function renderPaneModelControl(
  props: ModelControlProps,
  container: HTMLElement,
  openModelPicker = false,
) {
  if (openModelPicker) {
    props = { ...props, model: { ...props.model, modelPickerOpen: true } };
  }
  const mounted = modelControlViews.get(container);
  if (mounted) {
    mounted.update(props);
    return;
  }
  if (!container.isConnected) {
    document.body.append(container);
    onTestFinished(() => container.remove());
  }
  modelControlViews.set(container, mountSolid(ChatPaneModelControl, props, container));
  onTestFinished(() => {
    modelControlViews.delete(container);
  });
}
