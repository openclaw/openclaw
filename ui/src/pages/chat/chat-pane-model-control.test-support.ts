import { onTestFinished } from "vitest";
import { installModelPickerLayout } from "../../test-helpers/model-picker-layout.ts";
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
  installModelPickerLayout();
  const renderProps = openModelPicker
    ? { ...props, model: { ...props.model, modelPickerOpen: true } }
    : props;
  const mounted = modelControlViews.get(container);
  if (mounted) {
    mounted.update(renderProps);
    return;
  }
  if (!container.isConnected) {
    document.body.append(container);
    onTestFinished(() => container.remove());
  }
  modelControlViews.set(container, mountSolid(ChatPaneModelControl, renderProps, container));
  onTestFinished(() => {
    modelControlViews.delete(container);
  });
}
