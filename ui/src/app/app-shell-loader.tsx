import type { JSX as SolidJSX } from "@solidjs/web";
import { Errored, Loading, lazy, onCleanup } from "solid-js";
import { renderLazyViewError } from "../components/lazy-view-error.ts";
import { i18n } from "../i18n/index.ts";
import { projectI18n } from "../lib/reactive/i18n.ts";
import type { OpenClawShellProps } from "./app-host.tsx";
import { LitRouteHost } from "./lit-route-host.tsx";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
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
        />
      </Loading>
    </Errored>
  );
}

function ShellLoadError(props: { error: unknown; reset: () => void }): SolidJSX.Element {
  const translations = projectI18n(i18n);
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const retry = async () => {
    const stale = isStaleChunkImportError(props.error);
    const reloading =
      stale && (await retryStaleChunkReloadWhenReachable({ canReload: () => active }));
    if (active && !reloading) {
      props.reset();
    }
  };
  return (
    <LitRouteHost
      renderValue={() => {
        translations.revision();
        return renderLazyViewError({
          error: props.error,
          stale: isStaleChunkImportError(props.error),
          onRetry: () => {
            void retry();
          },
        });
      }}
    />
  );
}
