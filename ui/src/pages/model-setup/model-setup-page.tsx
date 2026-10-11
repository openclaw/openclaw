import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { ModelProviderLoginView } from "../model-providers/login-view.tsx";
import type { ModelSetupRouteData } from "./first-run-setup.ts";
import { ModelSetupController } from "./model-setup-controller.ts";
import { ModelSetupView } from "./view.tsx";

export type ModelSetupPageProps = {
  routeData?: ModelSetupRouteData;
  embedded?: boolean;
  agentLabel?: string;
  credentialChoices?: readonly string[];
  onClose?: () => void;
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-model-setup-page": HTMLAttributes<HTMLElement> & {
        [Key in keyof ModelSetupPageProps as `prop:${Key}`]?: ModelSetupPageProps[Key];
      };
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-model-setup-page": SolidBridgeElement<ModelSetupPageProps>;
  }
}

export function ModelSetupContent(props: {
  controller: ModelSetupController;
  revision: () => unknown;
}) {
  const current = createMemo(() => {
    props.revision();
    return props.controller.viewProps();
  });
  const login = (
    <ModelProviderLoginView controller={props.controller.login} revision={props.revision} />
  );
  return <ModelSetupView {...current()} login={login} revision={props.revision} />;
}

export function ModelSetupPageBody(props: ModelSetupPageProps & { host: HTMLElement }) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0);
  const controller = untrack(
    () => new ModelSetupController(props.host, context, () => setRevision((value) => value + 1)),
  );
  createEffect(
    () => ({
      routeData: props.routeData,
      embedded: props.embedded ?? false,
      agentLabel: props.agentLabel ?? "",
      credentialChoices: props.credentialChoices ?? [],
      onClose: props.onClose,
    }),
    (value) => {
      Object.assign(controller, value);
      controller.beforeUpdate();
      controller.requestUpdate();
    },
  );
  createEffect(revision, () => {
    controller.beforeUpdate();
    controller.afterUpdate();
  });
  onSettled(() => controller.connect());
  onCleanup(() => controller.disconnect());
  return <ModelSetupContent controller={controller} revision={revision} />;
}

export const ModelSetupPage = defineSolidBridge<ModelSetupPageProps>(
  "openclaw-model-setup-page",
  (props, host) => <ModelSetupPageBody {...props} host={host} />,
  {
    properties: {
      routeData: { default: undefined, attribute: false },
      embedded: { default: false, type: Boolean },
      agentLabel: { default: "" },
      credentialChoices: { default: [], attribute: false },
      onClose: { default: undefined, attribute: false },
    },
  },
);
