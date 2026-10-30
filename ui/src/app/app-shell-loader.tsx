import type { JSX as SolidJSX } from "@solidjs/web";
import { Errored, Loading, lazy, onSettled } from "solid-js";
import { LazyViewError } from "../components/solid/lazy-view-error.tsx";
import type { OpenClawShellProps } from "./app-host.tsx";
import {
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

export function ShellLoadError(props: { error: unknown; reset: () => void }): SolidJSX.Element {
  let active = true;
  const stale = () => isStaleChunkImportError(props.error);
  onSettled(() => {
    // A recognized shell-download failure joins the shared guarded recovery instead of
    // waiting for a manual Reload; a refused attempt still lands on this surface.
    if (stale()) {
      void scheduleStaleChunkReload();
    }
    return () => {
      active = false;
    };
  });
  const retry = async () => {
    const reloading =
      stale() && (await retryStaleChunkReloadWhenReachable({ canReload: () => active }));
    if (active && !reloading) {
      props.reset();
    }
  };
  return (
    <openclaw-route-fragment style={{ display: "contents" }}>
      <LazyViewError
        error={props.error}
        stale={stale()}
        onRetry={() => {
          void retry();
        }}
      />
    </openclaw-route-fragment>
  );
}
