import { registerSessionNavigationEnglish } from "../i18n/locales/en-session-navigation.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { newSessionSearch } from "../pages/new-session/location.ts";
import { PanelErrorState } from "./solid/lazy-view-error.tsx";

registerEnglishCatalog(registerSessionNavigationEnglish);

export function HomeSessionUnavailable(props: { agentId: string }) {
  const app = useApplication();
  return (
    <PanelErrorState
      class="session-route-not-found"
      role="status"
      title={t("chat.sessionRoute.homeUnavailableTitle")}
      subtitle={t("chat.sessionRoute.homeUnavailableBody")}
      actions={
        <button
          class="btn primary"
          type="button"
          onClick={() => {
            const agentId =
              app.agents.state.agentsList?.agents.find((agent) => agent.id === props.agentId)?.id ??
              "";
            app.navigate("new-session", { search: newSessionSearch(agentId) });
          }}
        >
          {t("chat.sessionRoute.startConversation")}
        </button>
      }
    />
  );
}
