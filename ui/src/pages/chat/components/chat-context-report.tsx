import { Show, createMemo, onSettled, type Element } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { sessionContextReportsForGateway } from "../../../lib/session-context-report.ts";
import { showToast } from "../../../lib/toast.ts";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

export const contextLabelKeys = {
  messages: "contextMessages",
  files: "contextFiles",
  tools: "contextTools",
  skills: "contextSkills",
  system: "contextSystem",
} as const;
export const contextGroupLabelKeys = {
  "agent-workspace": "contextAgentWorkspace",
  "execution-project": "contextProject",
  personal: "contextPersonal",
  other: "contextOtherFiles",
  openclaw: "contextSystemTools",
  mcp: "contextMcpTools",
  client: "contextClientTools",
  "unknown-tools": "contextTools",
} as const;

export type ContextReportProps = {
  gateway: ApplicationGateway;
  session: GatewaySessionRow;
  agentId?: string;
  used: number;
  presented?: boolean;
};
type ContextReportSnapshot = ReturnType<ReturnType<typeof sessionContextReportsForGateway>["get"]>;

/** Both presentations consume the same read owner; the callback retains its DOM across updates. */
export function ChatContextReport(
  props: ContextReportProps & {
    children: (read: () => ContextReportSnapshot, refresh: () => Promise<void>) => Element;
  },
) {
  const binding = createMemo(
    () => ({
      gateway: props.gateway,
      sessionKey: props.session.key,
      agentId: props.agentId,
      sessionId: props.session.sessionId,
      model: props.session.activeModel || props.session.model,
      provider: props.session.modelProvider,
    }),
    {
      equals: (a, b) =>
        a.gateway === b.gateway &&
        a.sessionKey === b.sessionKey &&
        a.agentId === b.agentId &&
        a.sessionId === b.sessionId &&
        a.model === b.model &&
        a.provider === b.provider,
    },
  );
  return (
    <Show when={binding()} keyed>
      {(identity) => {
        const owner = {};
        const reports = sessionContextReportsForGateway(identity.gateway);
        const target = () => ({ ...identity, used: props.used });
        const view = projectOwner(reports, (store) => store.get(target()));
        const result = view.read;
        let retained = true;
        onSettled(() => () => {
          retained = false;
          reports.unwatch(owner);
        });
        const demand = createMemo(() => (props.presented !== false ? target() : undefined), {
          equals: (previous, next) => previous?.used === next?.used,
        });
        const refresh = async () => {
          const outcome = await reports.refresh(target());
          if (
            retained &&
            props.presented !== false &&
            (outcome === "failed" || outcome === "offline")
          ) {
            showToast({
              message: t(
                outcome === "offline"
                  ? "chat.sessionDetails.contextOffline"
                  : "chat.sessionDetails.contextError",
              ),
              icon: "alertTriangle",
            });
          }
        };
        return (
          <>
            <Show when={demand()} keyed>
              {(current) => {
                onSettled(() => {
                  reports.watch(owner, current);
                  return () => {
                    if (retained) {
                      reports.watch(owner, current, false);
                    }
                  };
                });
                return null;
              }}
            </Show>
            {props.children(result, refresh)}
          </>
        );
      }}
    </Show>
  );
}
