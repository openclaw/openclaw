import { html } from "lit";
import type { CustodianRouteData } from "./route.ts";
import "./custodian-page.tsx";

// The router still consumes Lit templates; the registered page has one Solid owner.
export function renderCustodianRoute(data: CustodianRouteData | undefined) {
  return html`<openclaw-custodian-page
    .onboarding=${data?.onboarding === true}
    .newAgentIntent=${data?.intent === "new-agent"}
  ></openclaw-custodian-page>`;
}
