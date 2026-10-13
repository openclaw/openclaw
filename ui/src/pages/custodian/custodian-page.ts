import { html, nothing } from "lit";
import type { CustodianRouteData } from "./route.ts";
import "./custodian-page.tsx";

// The router still consumes Lit templates; the registered page has one Solid owner.
export function renderCustodianRoute(data: CustodianRouteData | undefined) {
  if (!data) {
    return nothing;
  }
  return html`<openclaw-custodian-page
    .onboarding=${data.onboarding}
    .newAgentIntent=${data.intent === "new-agent"}
  ></openclaw-custodian-page>`;
}
