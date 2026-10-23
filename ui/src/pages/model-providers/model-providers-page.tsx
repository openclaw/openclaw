import { createMemo } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { ModelProviderAccountRecovery, ModelProviderLoginView } from "./login-view.tsx";
import { createModelProviders, type ModelProvidersOwner } from "./model-providers-controller.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import {
  ModelProviders,
  renderModelProviderScope as ModelProviderScope,
  renderModelProvidersPageShell as ModelProvidersPageShell,
} from "./view.tsx";

export function ModelProvidersContent(props: { controller: ModelProvidersOwner }) {
  const current = createMemo(() => props.controller.viewProps());
  let initialLoadComplete = false;
  const showProviderDetails = createMemo(() => {
    const snapshot = current();
    if (
      snapshot.props.connected &&
      !snapshot.props.loading &&
      props.controller.installedAgents.initialized
    ) {
      initialLoadComplete = true;
    }
    return initialLoadComplete || !snapshot.props.connected;
  });
  const Recovery = () => <ModelProviderAccountRecovery controller={props.controller.login} />;
  const Login = () => <ModelProviderLoginView controller={props.controller.login} />;
  const cards = createMemo(() => current().cards);
  const discoveryData = createMemo(() => current().discovery);
  const InstalledAgents = () =>
    props.controller.installedAgents.render(cards, props.controller.retryCatalog);
  const Discovery = () => props.controller.discovery.render(discoveryData);
  const installedAgents = <InstalledAgents />;
  return (
    <ModelProvidersPageShell
      body={
        <ModelProviders
          {...current().props}
          defaultsSaving={props.controller.mutations.defaultsSaving()}
          logoutSaving={props.controller.logoutSaving()}
          providerDetailsReady={showProviderDetails()}
          accountRecovery={<Recovery />}
          installedAgents={current().installedAgentsAvailable ? installedAgents : undefined}
          providerScope={<ModelProviderScope {...current().scope} />}
        />
      }
      loginMessage={current().loginMessage}
      login={
        <>
          <Login />
          <Discovery />
        </>
      }
    />
  );
}

export type ModelProvidersPageProps = {
  routeData?: ModelProvidersRouteData;
  loaderPending?: boolean;
};

export function ModelProvidersPageBody(props: ModelProvidersPageProps) {
  const context: ApplicationContext = useApplication();
  const controller = createModelProviders(context, props);
  return <ModelProvidersContent controller={controller} />;
}

export function ModelProvidersPage(props: ModelProvidersPageProps) {
  return (
    <openclaw-model-providers-page>
      <ModelProvidersPageBody {...props} />
    </openclaw-model-providers-page>
  );
}
