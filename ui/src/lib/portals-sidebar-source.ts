import type { PortalSummary } from "@openclaw/gateway-protocol";
import { createSignal, onSettled, untrack } from "solid-js";

/** What the open Portals page shares with the Portals sidebar: its own list, never a second read. */
export type PortalsSidebarSource = {
  portals(): readonly PortalSummary[];
  /** The portal the page has open, so the sidebar marks its row. */
  openPortalId(): string | null;
  /** Opens a portal on the page at once; its address follows through navigation. */
  open(portalId: string): void;
};

const [source, setSource] = createSignal<PortalsSidebarSource | null>(null);

/** The Portals page's list for the sidebar, for as long as the calling owner lives. */
export function createPortalsSidebarSource(value: PortalsSidebarSource): void {
  onSettled(() => {
    setSource(value);
    return () => {
      if (untrack(source) === value) {
        setSource(null);
      }
    };
  });
}

/** The open Portals page's list, or null while no Portals page is mounted. */
export function portalsSidebarSource(): PortalsSidebarSource | null {
  return source();
}
