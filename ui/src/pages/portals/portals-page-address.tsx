import type { PortalSummary } from "@openclaw/gateway-protocol";
import { createEffect, createSignal, onSettled } from "solid-js";
import { createPortalsSidebarSource } from "../../lib/portals-sidebar-source.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { rememberSectionLocation, sectionLocation } from "../../lib/section-navigation.ts";
import type { PortalsModel } from "./portals-state.ts";

/**
 * The standalone page opens the portal its address names, lends its list to the Portals
 * sidebar, and remembers the open portal so returning to Portals in this tab reopens it.
 */
export function PortalsPageAddress(props: {
  model: PortalsModel;
  selectedPortal: () => PortalSummary | undefined;
}) {
  const context = useApplication();
  const addressed = () => {
    const match = context.router.getState().matches[0];
    return match?.routeId === "portals"
      ? new URLSearchParams(match.location.search).get("portal")
      : null;
  };
  const [portalId, setPortalId] = createSignal(addressed());
  onSettled(() => {
    const stop = context.router.subscribe(() => setPortalId(addressed()));
    const opened = sectionLocation(context.gateway, "portals");
    if (!addressed() && opened) {
      context.replace(opened.route, opened.options);
    }
    return stop;
  });
  createEffect(
    () => portalId(),
    (id) => {
      if (id) {
        props.model.openPortal(id);
      }
    },
  );
  createEffect(
    () => props.selectedPortal()?.id,
    (id) => {
      if (id) {
        rememberSectionLocation(context.gateway, "portals", {
          route: "portals",
          options: { search: `?portal=${encodeURIComponent(id)}` },
        });
      }
    },
  );
  createPortalsSidebarSource({
    portals: () => props.model.state().portals,
    openPortalId: () => props.selectedPortal()?.id ?? null,
    open: (id) => props.model.openPortal(id),
  });
  return null;
}
