import { html } from "lit";
import { createComponent, Show } from "solid-js";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import type { GitHubIdentityController } from "./github-identity-controller.ts";
import { GitHubIdentity } from "./github-identity-view.tsx";

defineSolidBridge<{
  controller: GitHubIdentityController | null;
  revision: object | null;
  onOpenConnections: () => void;
}>(
  "openclaw-github-identity",
  (props) =>
    createComponent(Show, {
      get when() {
        return props.controller !== null;
      },
      children: () =>
        createComponent(GitHubIdentity, {
          get controller() {
            void props.revision;
            return props.controller!;
          },
          get onOpenConnections() {
            return props.onOpenConnections;
          },
        }),
    }),
  {
    properties: {
      controller: { default: null, attribute: false },
      revision: { default: null, attribute: false },
      onOpenConnections: { default: () => {}, attribute: false },
    },
  },
);

/** Remaining Lit callers publish an invalidation for their mutable controller. */
export function renderGitHubIdentity(
  controller: GitHubIdentityController,
  onOpenConnections: () => void,
) {
  return html`<openclaw-github-identity
    style="display: contents"
    .controller=${controller}
    .revision=${{}}
    .onOpenConnections=${onOpenConnections}
  ></openclaw-github-identity>`;
}
