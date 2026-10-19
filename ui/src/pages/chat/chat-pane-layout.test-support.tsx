import { dynamic, type JSX } from "@solidjs/web";

// Browser files share a module graph, so their pane mock must accept either fixture's data.
export function PaneLayout<Props extends object>(props: {
  layout: { component: (props: Props) => JSX.Element; props: Props };
}) {
  const View = dynamic(() => props.layout.component);
  return <View {...props.layout.props} />;
}
