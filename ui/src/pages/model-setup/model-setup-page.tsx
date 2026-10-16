import { createMemo } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { ModelProviderLoginView } from "../model-providers/login-view.tsx";
import { createModelSetup, type ModelSetupPageProps } from "./model-setup-owner.ts";
import { ModelSetupView } from "./view.tsx";

export function ModelSetupPageBody(props: ModelSetupPageProps & { host: HTMLElement }) {
  const setup = createModelSetup(props, useApplication());
  const current = createMemo(setup.view);
  return (
    <ModelSetupView
      {...current()}
      revision={setup.revision}
      login={<ModelProviderLoginView controller={setup.login} />}
    />
  );
}

export function ModelSetupPage(props: ModelSetupPageProps) {
  let host!: HTMLElement;
  return (
    <openclaw-model-setup-page ref={(element) => (host = element)}>
      <ModelSetupPageBody {...props} host={host} />
    </openclaw-model-setup-page>
  );
}
