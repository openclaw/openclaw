import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
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

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-model-providers-page": HTMLAttributes<HTMLElement> & {
        [Key in keyof ModelProvidersPageProps as `prop:${Key}`]?: ModelProvidersPageProps[Key];
      };
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-model-providers-page": SolidBridgeElement<ModelProvidersPageProps>;
  }
}

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

export const ModelProvidersPage = defineSolidBridge<ModelProvidersPageProps>(
  "openclaw-model-providers-page",
  (props, host) => <ModelProvidersPageBody {...props} host={host} />,
  {
    properties: {
      routeData: { default: undefined, attribute: false },
      loaderPending: { default: false, attribute: false },
    },
  },
);
