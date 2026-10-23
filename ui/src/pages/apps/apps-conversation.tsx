import "../chat/route-entry.ts";
import { lazy, Loading, Show } from "solid-js";
import type { McpAppOpenDetail } from "../../components/mcp-app-launch.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ChatPaneView } from "../chat/chat-pane.tsx";

const DiscoveryStatus = lazy(() => import("../../components/mcp-app-discovery-status.tsx"));

type AppsConversationProps = {
  launch: McpAppOpenDetail | undefined;
  connectionRevision: number;
  request: { promise: Promise<void> } | undefined;
};

// Load the conversation and its styles while discovery resolves the app URL.
export default function AppsConversation(props: AppsConversationProps) {
  const paneKey = () =>
    props.launch ? JSON.stringify([props.launch.sessionKey, props.connectionRevision]) : "";
  return (
    <Show
      when={paneKey()}
      keyed
      fallback={
        <Loading fallback={<p role="status">{t("mcpApp.loading")}</p>}>
          <DiscoveryStatus
            request={props.request}
            emptyMessage={t("mcpApp.invalidLink")}
            emptyRole="alert"
          />
        </Loading>
      }
    >
      <ChatPaneView
        class="mcp-app-conversation"
        sessionKey={props.launch!.sessionKey}
        agentId={props.launch!.agentId}
        paneId="plugin-app"
        presentationId={`plugin-app:${props.launch!.sessionKey}`}
        mcpAppLaunch={props.launch}
      />
    </Show>
  );
}
