import { dynamic, type JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { PaneLayout as NativePaneLayout } from "./chat-pane-layout-view.tsx";
type RealPaneProps = Parameters<typeof NativePaneLayout>[0];

// Browser files share a module graph, so their pane mock must accept either fixture's data.
export function createPaneLayoutFixture(RealPaneLayout: typeof NativePaneLayout) {
  function PaneLayout<Props extends object>(props: {
    layout: { component: (props: Props) => JSX.Element; props: Props } | RealPaneProps["layout"];
    questions: RealPaneProps["questions"];
  }) {
    const fixture = () => {
      const layout = props.layout;
      return layout && "component" in layout ? layout : undefined;
    };
    const realLayout = () => {
      const layout = props.layout;
      return layout && "component" in layout ? null : layout;
    };
    const View = dynamic(() => fixture()?.component);
    return (
      <Show
        when={fixture()}
        fallback={<RealPaneLayout layout={realLayout()} questions={props.questions} />}
      >
        {(layout) => <View {...layout().props} />}
      </Show>
    );
  }
  return { PaneLayout };
}
