import { lazy } from "solid-js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { activeElement } from "../../../components/focus-navigation.ts";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { VoiceSnippetDialogBoundary } from "./voice-snippet-dialog-boundary.tsx";

const CatalogDialog = lazy(() => import("./voice-snippets-dialog.tsx"), {
  export: "VoiceSnippetCatalogDialog",
});
const openCatalogs = new WeakSet<GatewayBrowserClient>();

/** Callers retire the signal when connection, account, or owning draft changes. */
export async function showVoiceSnippetCatalog(options: {
  client: GatewayBrowserClient;
  signal: AbortSignal;
}): Promise<void> {
  if (openCatalogs.has(options.client) || options.signal.aborted) {
    return;
  }
  openCatalogs.add(options.client);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const returnFocus = activeElement(document.body);
  try {
    await withPromiseModalHost<void>({ signal, value: undefined }, (modal) => {
      const context = {
        client: options.client,
        signal,
        returnFocus,
        onClose: () => modal.finish(),
      };
      modal.render(() => (
        <VoiceSnippetDialogBoundary signal={signal} onClose={context.onClose}>
          <CatalogDialog context={context} />
        </VoiceSnippetDialogBoundary>
      ));
    });
  } finally {
    lifetime.abort();
    openCatalogs.delete(options.client);
  }
}
