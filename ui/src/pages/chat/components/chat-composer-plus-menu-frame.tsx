import { onSettled } from "solid-js";
import type { MenuEntry, MenuItem } from "../../../components/solid/menu.tsx";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import type { ChatComposerPlusMenuResolvedProps } from "./chat-composer-plus-menu.types.ts";

type ChatComposerPlusMenuFrameProps = ChatComposerPlusMenuResolvedProps & {
  items: () => readonly MenuEntry[];
  height?: number;
  select: (item: MenuItem, event: CustomEvent<MenuItem>) => void;
  onBody?: (element: HTMLDivElement) => void;
};

export function ChatComposerPlusMenuFrame(props: ChatComposerPlusMenuFrameProps) {
  let body!: HTMLDivElement;
  createLayoutMeasurement(
    () => ({ items: props.items(), height: props.height }),
    () => {
      if (!body) {
        return undefined;
      }
      const panel = props.readMenu().overlay.surface;
      const style = getComputedStyle(panel);
      // Measure content without the opening scale or the scroll viewport's current clamp.
      const contentHeight = [...body.children].reduce((total, child) => {
        if (!(child instanceof HTMLElement)) {
          return total;
        }
        const childStyle = getComputedStyle(child);
        return (
          total +
          Math.max(child.scrollHeight, Number.parseFloat(childStyle.height) || 0) +
          Number.parseFloat(childStyle.marginTop) +
          Number.parseFloat(childStyle.marginBottom)
        );
      }, 0);
      const staticHeight = Math.ceil(
        (props.height ?? contentHeight) +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom) +
          Number.parseFloat(style.borderTopWidth) +
          Number.parseFloat(style.borderBottomWidth),
      );
      return () => {
        panel.style.height = `${staticHeight}px`;
      };
    },
    { targets: () => (body ? [body] : []), fonts: true },
  );
  onSettled(() => {
    props.onReady({
      items: props.items,
      select: (item, event) => props.select(item, event),
      navigate: (value) => props.menu.onNavigate(value === "manage-skills" ? "skills" : "plugins"),
    });
    return () => props.onReady(undefined);
  });
  return (
    <div
      ref={(element) => {
        body = element;
        props.onBody?.(element);
      }}
      class="agent-chat__capability-menu-body"
      style={{ height: props.height === undefined ? undefined : `${props.height}px` }}
    >
      {props.renderItems(props.items)}
    </div>
  );
}
