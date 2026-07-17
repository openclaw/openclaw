import { html, nothing } from "lit";
import type { CustodianRouteData } from "./route.ts";

export function renderCustodianRoute(data: CustodianRouteData | undefined) {
  const onboarding = data?.onboarding === true;
  return html`
    ${onboarding
      ? nothing
      : html`<style>
          openclaw-custodian-page.custodian-route--normal .custodian__header > .btn {
            display: none;
          }
        </style>`}
    <openclaw-custodian-page
      class=${onboarding ? "custodian-route--onboarding" : "custodian-route--normal"}
    ></openclaw-custodian-page>
  `;
}
