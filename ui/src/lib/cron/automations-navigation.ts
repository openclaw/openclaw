import { createSignal } from "solid-js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";

type Scope = ReturnType<typeof gatewayPresentationScope>;

// The automation last opened in this tab, per Gateway, so Automations reopens on it.
let opened: { scope: Scope; jobId: string } | null = null;

export function openedCronJob(gateway: ApplicationGateway): string | null {
  return opened?.scope === gatewayPresentationScope(gateway) ? opened.jobId : null;
}

export function setOpenedCronJob(gateway: ApplicationGateway, jobId: string | null): void {
  opened = jobId ? { scope: gatewayPresentationScope(gateway), jobId } : null;
}

// While the Automations sidebar is open beside the page, it lists every automation, so the
// page need not list them too. The sidebar owns this fact; it is false while collapsed.
const [automationsSidebarShown, setAutomationsSidebarShown] = createSignal(false);
export { automationsSidebarShown, setAutomationsSidebarShown };
