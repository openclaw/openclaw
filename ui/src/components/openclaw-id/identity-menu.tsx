import { createMemo } from "solid-js";
import type { OpenClawIdPeopleLink, OpenClawIdStatusResult } from "../../lib/openclaw-id/types.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import {
  renderSidebarIdentityMenu as SidebarIdentityMenu,
  type SidebarIdentityMenuParams,
} from "../app-sidebar-identity-menu.tsx";
import {
  openClawIdMenuEntries,
  openClawIdMenuIdentity,
  openClawIdSignOutEntries,
  selectOpenClawIdMenuValue,
} from "./account-menu.tsx";

/** The enabled-only account adapter; off renders the ordinary menu without this module. */
export function OpenClawIdIdentityMenu(props: SidebarIdentityMenuParams) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const client = createMemo(() => {
    const snapshot = gateway.read().snapshot;
    return snapshot.phase === "connected" ? snapshot.client : null;
  });
  const status = createMemo(
    async () =>
      client()
        ?.request<OpenClawIdStatusResult>("openclawId.status", {})
        .catch(() => null) ?? null,
    { loadingValue: null },
  );
  // The publication (owner-only) for this computer's key warnings: superseded or needing a code.
  const publication = createMemo(
    async () => {
      const current = status();
      if (current?.channel !== "local_operator" || !current.owner || !current.link.linked) {
        return null;
      }
      return (
        (await client()
          ?.request<{ link: OpenClawIdPeopleLink }>("openclawId.people", {})
          .then(({ link }) => link.publication ?? null)
          .catch(() => null)) ?? null
      );
    },
    { loadingValue: null },
  );
  const extension = createMemo(() => {
    const current = status();
    if (!current || current.status.state === "off") {
      return undefined;
    }
    return {
      identity: openClawIdMenuIdentity(current),
      entries: openClawIdMenuEntries(current, publication()),
      signOut: openClawIdSignOutEntries(current),
      onSelect: (value: string) =>
        selectOpenClawIdMenuValue(value, {
          status: status(),
          client: context.gateway.snapshot.client,
          basePath: props.basePath,
          onKeysChanged: () => context.sidebarAttention.refreshOpenClawId(),
        }),
    };
  });
  return <SidebarIdentityMenu {...props} extension={extension()} />;
}
