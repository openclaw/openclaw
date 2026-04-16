type NpmUpdateCompatSidecar = {
  path: string;
  content: string;
};

export const NPM_UPDATE_COMPAT_SIDECARS: readonly NpmUpdateCompatSidecar[] = [];

export const NPM_UPDATE_COMPAT_SIDECAR_PATHS = new Set<string>(
  NPM_UPDATE_COMPAT_SIDECARS.map((entry) => entry.path),
);

export const NPM_UPDATE_OMITTED_BUNDLED_PLUGIN_ROOTS = new Set<string>([
  "dist/extensions/qa-lab",
  "dist/extensions/qa-matrix",
]);
