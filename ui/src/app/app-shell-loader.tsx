import type { JSX as SolidJSX } from "@solidjs/web";
import { Errored, Loading, lazy, onSettled } from "solid-js";
import { LazyViewError } from "../components/solid/lazy-view-error.tsx";
import { ConnectingSplash } from "../components/solid/loading-skeleton.tsx";
import { t } from "../lib/reactive/i18n.ts";
import type { OpenClawShellProps } from "./app-host.tsx";
import { bootComposerElement } from "./boot-composer.ts";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

const LazyShell = lazy(() => import("./app-host.tsx"), { export: "OpenClawShell" });

type ShellLoaderProps = OpenClawShellProps & { fallback: SolidJSX.Element };

/** Sign-in and standalone documents never acquire the workspace shell's graph. */
export function ShellLoader(props: ShellLoaderProps): SolidJSX.Element {
  return (
    <Errored fallback={(error, reset) => <ShellLoadError error={error()} reset={reset} />}>
      <Loading fallback={props.fallback}>
        <LazyShell
          runtime={props.runtime}
          getReadiness={props.getReadiness}
          onboarding={props.onboarding}
          onShell={props.onShell}
        />
      </Loading>
    </Errored>
  );
}

function ShellLoadError(props: { error: unknown; reset: () => void }): SolidJSX.Element {
  let active = true;
  onSettled(() => {
    if (isStaleChunkImportError(props.error)) {
      void scheduleStaleChunkReload({ canReload: () => active });
    }
    return () => {
      active = false;
      if (isStaleChunkImportError(props.error)) {
        cancelStaleChunkRecovery();
      }
    };
  });
  const retry = async () => {
    const stale = isStaleChunkImportError(props.error);
    const reloading =
      stale && (await retryStaleChunkReloadWhenReachable({ canReload: () => active }));
    if (active && !reloading) {
      props.reset();
    }
  };
  const failure = () => (
    <LazyViewError
      error={props.error}
      stale={isStaleChunkImportError(props.error)}
      subtitle={
        bootComposerElement() && isStaleChunkImportError(props.error)
          ? t("lazyView.bootDraftRecovery")
          : undefined
      }
      onRetry={() => {
        void retry();
      }}
    />
  );
  return (
    <openclaw-route-fragment style={{ display: "contents" }}>
      {bootComposerElement() ? (
        <ConnectingSplash
          status={t(
            isStaleChunkImportError(props.error) ? "lazyView.staleTitle" : "lazyView.errorTitle",
          )}
        >
          {failure()}
        </ConnectingSplash>
      ) : (
        failure()
      )}
    </openclaw-route-fragment>
  );
}
