import type { ApplicationGateway } from "./gateway.ts";

/** The pre-authentication document retains bundled artwork until an owner is known. */
export function deferInstallIconProfile(
  gateway: ApplicationGateway,
  basePath: string,
  isDocumentGateway: () => boolean,
) {
  let stopped = false;
  let release: (() => void) | undefined;
  void import("./pwa-install-selection.ts").then(({ bindInstallIconProfile }) => {
    if (!stopped) {
      release = bindInstallIconProfile(gateway, basePath, isDocumentGateway);
    }
  });
  return () => {
    stopped = true;
    release?.();
  };
}
