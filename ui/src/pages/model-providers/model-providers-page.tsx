import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { ModelProviderAccountRecovery, ModelProviderLoginView } from "./login-view.tsx";
import { ModelProvidersController } from "./model-providers-controller.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import {
  ModelProviders,
  renderModelProviderScope as ModelProviderScope,
  renderModelProvidersPageShell as ModelProvidersPageShell,
} from "./view.tsx";

export function ModelProvidersContent(props: {
  controller: ModelProvidersController;
  revision: () => unknown;
}) {
  // A mounted content subtree belongs to one controller lifetime.
  const controller = untrack(() => props.controller);
  const revision = () => props.revision();
  const current = createMemo(() => {
    revision();
    return controller.viewProps();
  });
  let initialLoadComplete = false;
  const showProviderDetails = createMemo(() => {
    const snapshot = current();
    if (
      snapshot.props.connected &&
      !snapshot.props.loading &&
      controller.installedAgents.initialized
    ) {
      initialLoadComplete = true;
    }
    return initialLoadComplete || !snapshot.props.connected;
  });
  const Recovery = () => (
    <ModelProviderAccountRecovery controller={controller.login} revision={revision} />
  );
  const Login = () => <ModelProviderLoginView controller={controller.login} revision={revision} />;
  const cards = createMemo(() => current().cards);
  const discoveryData = createMemo(() => current().discovery);
  const InstalledAgents = () =>
    controller.installedAgents.render(cards, () => controller.retryCatalog(), revision);
  const Discovery = () => controller.discovery.render(discoveryData, revision);
  const installedAgents = <InstalledAgents />;
  return (
    <ModelProvidersPageShell
      body={
        <ModelProviders
          {...current().props}
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

export function ModelProvidersPageBody(props: ModelProvidersPageProps & { host: HTMLElement }) {
  const context: ApplicationContext = useApplication();
  const [revision, setRevision] = createSignal(0);
  const controller = new ModelProvidersController(
    untrack(() => props.host),
    context,
    () => setRevision((value) => value + 1),
  );
  createEffect(
    () => ({ routeData: props.routeData, loaderPending: props.loaderPending ?? false }),
    (value) => {
      controller.routeData = value.routeData;
      controller.loaderPending = value.loaderPending;
      controller.beforeUpdate();
    },
  );
  createEffect(revision, () => {
    controller.beforeUpdate();
    controller.afterUpdate();
  });
  onSettled(() => controller.connect());
  onCleanup(() => controller.disconnect());
  return <ModelProvidersContent controller={controller} revision={revision} />;
}

export function ModelProvidersPage(props: ModelProvidersPageProps) {
  let host!: HTMLElement;
  return (
    <openclaw-model-providers-page ref={(element) => (host = element)}>
      <ModelProvidersPageBody {...props} host={host} />
    </openclaw-model-providers-page>
  );
}
