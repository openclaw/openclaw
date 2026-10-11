import { createRenderEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { McpAppExtensionTarget } from "../../../../src/shared/mcp-app-extensions.js";
import type { ApplicationContext } from "../../app/context.ts";
import { McpAppCatalogController } from "../mcp-app-catalog.ts";

/** Shares the discovery owner with Lit consumers until their renderer cutover. */
export function useMcpAppCatalog(
  context: ApplicationContext,
  target: () => McpAppExtensionTarget,
  prepareSession: () => boolean = () => false,
) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const catalog = new McpAppCatalogController(
    { requestUpdate: () => setRevision((value) => value + 1) },
    () => context,
    () => untrack(target),
    () => untrack(prepareSession),
  );
  catalog.hostConnected();
  createRenderEffect(
    () => [target(), prepareSession()],
    () => untrack(() => catalog.hostUpdate()),
  );
  onCleanup(() => catalog.hostDisconnected());
  return () => {
    revision();
    return catalog;
  };
}
