import type { BoardProvider } from "../board/provider.ts";
import { projectSource } from "./projection.ts";

function readBoardProvider(provider: BoardProvider) {
  return {
    snapshot: provider.snapshot$.value,
    loadError: provider.loadError$.value,
    sessionKey: provider.sessionKey,
    appViewGeneration: provider.appViewGeneration,
    hasLoadedSnapshot: provider.hasLoadedSnapshot,
    canMutate: provider.canMutate,
    canGrant: provider.canGrant,
    canPinWidgets: provider.canPinWidgets,
    canPinMcpApps: provider.canPinMcpApps,
  };
}

function subscribeBoardProvider(provider: BoardProvider, notify: () => void) {
  const stopSnapshot = provider.snapshot$.subscribe(notify);
  const stopError = provider.loadError$.subscribe(notify);
  return () => {
    stopSnapshot();
    stopError();
  };
}

/** For an existing lifecycle-owned provider, including GatewayBoardProvider. */
export function projectBoardProvider(source: BoardProvider) {
  return projectSource(source, {
    read: readBoardProvider,
    subscribe: subscribeBoardProvider,
    equality: "revision",
  });
}
