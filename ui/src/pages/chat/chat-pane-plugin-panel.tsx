import type { PresentationValue } from "../../lib/presentation.ts";
import { PluginView } from "../../plugins/control-ui-view.solid.tsx";
import { usePanePresentation } from "./chat-pane-presentation.ts";

export function EmbeddedPluginPanel(props: {
  contributionKey: string;
  props: { sessionKey: string; agentId?: string };
  presentation: PresentationValue;
}) {
  const presented = usePanePresentation(() => props.presentation);
  return (
    <PluginView
      data-sidebar-panel-host
      kind="panels"
      contributionKey={props.contributionKey}
      props={props.props}
      presented={presented()}
    />
  );
}
