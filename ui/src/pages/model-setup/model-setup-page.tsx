import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
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

export function ModelSetupPage(props: ModelSetupPageProps) {
  let host!: HTMLElement;
  return (
    <openclaw-model-setup-page ref={(element) => (host = element)}>
      <ModelSetupPageBody {...props} host={host} />
    </openclaw-model-setup-page>
  );
}
