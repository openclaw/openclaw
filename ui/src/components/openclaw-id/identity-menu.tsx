import { createMemo, onSettled, refresh } from "solid-js";
import type { GatewayEventListener } from "../../api/gateway.ts";
import type {
  OpenClawIdPeopleLink,
  OpenClawIdPublication,
  OpenClawIdStatusResult,
} from "../../lib/openclaw-id/types.ts";
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
  const connection = createMemo(
    () => {
      const { snapshot, connectionRevision } = gateway.read();
      return snapshot.phase === "connected" && snapshot.client
        ? { client: snapshot.client, revision: connectionRevision }
        : null;
    },
    { equals: (a, b) => a?.client === b?.client && a?.revision === b?.revision },
  );
  const status = createMemo(
    async () =>
      connection()
        ?.client.request<OpenClawIdStatusResult>("openclawId.status", {})
        .catch(() => null) ?? null,
    { loadingValue: null },
  );
  // A failed reread retains this owner's warning; retiring its scope disposes that projection.
  const publication = createMemo(() => {
    const owner = connection();
    const current = status();
    if (!owner || current?.channel !== "local_operator" || !current.owner || !current.link.linked) {
      return null;
    }
    const read = createMemo<OpenClawIdPublication | null>(
      (previous) =>
        owner.client
          .request<{ link: OpenClawIdPeopleLink }>("openclawId.people", {})
          .then(({ link }) => link.publication ?? null)
          .catch(() => previous),
      { loadingValue: null },
    );
    const onGatewayEvent: GatewayEventListener = (event) => {
      if (event.event === "openclawId.people.changed") {
        void refresh(read);
      }
    };
    onSettled(() => context.gateway.subscribeEvents(onGatewayEvent));
    return read;
  });
  const extension = createMemo(() => {
    const current = status();
    if (!current || current.status.state === "off") {
      return undefined;
    }
    return {
      identity: openClawIdMenuIdentity(current),
      entries: openClawIdMenuEntries(current, publication()?.()),
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
