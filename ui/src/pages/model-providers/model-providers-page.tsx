import { createMemo, createSignal, lazy, Loading, Show } from "solid-js";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { modelCatalogRef } from "./data.ts";
import { buildLoginProviders } from "./login-providers.ts";
import { ModelProviderAccountRecovery, ModelProviderLoginView } from "./login-view.tsx";
import { createModelProviders, type ModelProvidersOwner } from "./model-providers-controller.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import {
  ModelProviders,
  renderModelProvidersPageShell as ModelProvidersPageShell,
} from "./view.tsx";

// The route loader starts this import with first-run data, so detected models arrive with the page.
const FirstRunModelSetup = lazy(() => import("../model-setup/model-setup-page.tsx"), {
  export: "FirstRunModelSetup",
});

export function ModelProvidersContent(props: {
  controller: ModelProvidersOwner;
  /** First-run setup adds detected models, activation recovery and the onboarding handoff. */
  firstRun?: boolean;
}) {
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
  const catalogDiscovering = createMemo(() => current().props.catalogDiscovering);
  const discoveryData = createMemo(() => current().discovery);
  const InstalledAgents = () =>
    props.controller.installedAgents.render(
      cards,
      props.controller.retryCatalog,
      catalogDiscovering,
    );
  const Discovery = () => props.controller.discovery.render(discoveryData);
  const installedAgents = <InstalledAgents />;
  // First-run setup owns local discovery, so its activations keep their recovery receipt.
  const [firstRunDiscovery, setFirstRunDiscovery] = createSignal(false);
  // An unresolved first-run activation may still commit; no catalog attempt may replace it.
  const [firstRunUnresolved, setFirstRunUnresolved] = createSignal(false);
  const firstRunSetup = (
    <Show when={props.firstRun}>
      <Loading>
        <FirstRunModelSetup
          discoveryOpen={firstRunDiscovery()}
          agentLabel={discoveryData().agentLabel}
          credentialChoices={discoveryData().credentialChoices}
          onActivationUnresolved={setFirstRunUnresolved}
          onClose={() => {
            setFirstRunDiscovery(false);
            current().props.onRefresh();
          }}
        />
      </Loading>
    </Show>
  );
  // Installed agents report their own listing failures on their rows; an error naming only them
  // repeats that. A failing provider without a card isn't set up, so it stays quiet too.
  const agentFailuresOnly = createMemo(() => {
    const failures = current().cards.filter((card) => card.catalogStatus === "unavailable");
    return (
      failures.length > 0 &&
      failures.every((card) => props.controller.installedAgents.owns(card.id))
    );
  });
  const catalogProviders = createMemo(() =>
    buildLoginProviders({ authStatus: current().props.authStatus, allowQuickApiKey: true }),
  );
  // Sign-in sets the agent's own model and leaves the global default alone, so the default row
  // names the model this agent really uses when the two differ.
  const agentModel = createMemo(() => {
    const view = current().props;
    const model = view.agentModelRef ? splitTrailingAuthProfile(view.agentModelRef).model : "";
    if (!model || model === splitTrailingAuthProfile(view.defaultModels.primary).model) {
      return undefined;
    }
    const name = view.configuredModels.find((entry) => modelCatalogRef(entry) === model)?.name;
    return t("modelProviders.defaults.agentModel", {
      agent: view.credentialAgentLabel,
      model: name ?? model,
    });
  });
  return (
    <ModelProvidersPageShell
      body={
        <ModelProviders
          {...current().props}
          defaultsSaving={props.controller.mutations.defaultsSaving()}
          defaultsSavingField={props.controller.mutations.defaultsSavingField()}
          defaultsSaved={props.controller.mutations.defaultsSaved()}
          logoutSaving={props.controller.logoutSaving()}
          providerDetailsReady={showProviderDetails()}
          accountRecovery={<Recovery />}
          firstRunSetup={firstRunSetup}
          firstRunUnresolved={firstRunUnresolved()}
          installedAgents={current().installedAgentsAvailable ? installedAgents : undefined}
          agentModel={agentModel()}
          catalogReceipt={agentFailuresOnly() ? undefined : current().props.catalogReceipt}
          catalogDiscoveryError={agentFailuresOnly() ? null : current().props.catalogDiscoveryError}
          catalogProviders={catalogProviders()}
          onCatalogConnect={(providerId) => {
            const { login } = props.controller;
            const group = catalogProviders().find((entry) => entry.id === providerId);
            // A provider with one way in starts it; the rest open its method step.
            if (
              group &&
              current().props.canMutate &&
              !login.busy &&
              !firstRunUnresolved() &&
              !login.enter(group)
            ) {
              void login.open(group.authProviders, { select: group.id });
            }
          }}
          onDiscover={() =>
            props.firstRun ? setFirstRunDiscovery(true) : current().props.onDiscover()
          }
          discoverDisabled={
            !current().props.canMutate ||
            props.controller.discovery.busy ||
            firstRunDiscovery() ||
            current().props.loginBusy ||
            current().props.addProviderOpen
          }
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

function SettingsModelProviders(props: ModelProvidersPageProps) {
  const controller = createModelProviders(useApplication(), props);
  return <ModelProvidersContent controller={controller} />;
}

function FirstRunModelProviders(props: ModelProvidersPageProps) {
  const context: ApplicationContext = useApplication();
  // First run sets up the agent the app uses, so that is the agent this Models page edits.
  const firstRunContext: ApplicationContext = Object.create(context, {
    settingsAgentSelection: { value: context.agentSelection },
  });
  const controller = createModelProviders(firstRunContext, props);
  return <ModelProvidersContent controller={controller} firstRun />;
}

export function ModelProvidersPageBody(props: ModelProvidersPageProps) {
  // Each mode keeps one selection owner for its mount; changing mode remounts the page body.
  const firstRun = createMemo(() => props.routeData?.firstRun === true);
  return (
    <Show when={firstRun()} fallback={<SettingsModelProviders {...props} />}>
      <FirstRunModelProviders {...props} />
    </Show>
  );
}

export function ModelProvidersPage(props: ModelProvidersPageProps) {
  return (
    <openclaw-model-providers-page>
      <ModelProvidersPageBody {...props} />
    </openclaw-model-providers-page>
  );
}
