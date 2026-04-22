const LEGACY_QA_LAB_DIR = ["qa", "lab"].join("-");

type NpmUpdateCompatSidecar = {
  path: string;
  content: string;
};

export const NPM_UPDATE_COMPAT_SIDECARS = [] as readonly NpmUpdateCompatSidecar[];

export const NPM_UPDATE_COMPAT_SIDECAR_PATHS = new Set<string>(
  NPM_UPDATE_COMPAT_SIDECARS.map((entry) => entry.path),
);

export const NPM_UPDATE_OMITTED_BUNDLED_PLUGIN_ROOTS = new Set<string>([
  `dist/extensions/${LEGACY_QA_LAB_DIR}`,
  "dist/extensions/qa-matrix",
]);
