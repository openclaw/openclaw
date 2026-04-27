const LEGACY_QA_CHANNEL_DIR = ["qa", "channel"].join("-");
const LEGACY_QA_LAB_DIR = ["qa", "lab"].join("-");
const EMPTY_RUNTIME_SIDECAR = "export {};\n";
export const NPM_UPDATE_COMPAT_SIDECARS = [
    {
        path: `dist/extensions/${LEGACY_QA_CHANNEL_DIR}/runtime-api.js`,
        content: EMPTY_RUNTIME_SIDECAR,
    },
    {
        path: `dist/extensions/${LEGACY_QA_LAB_DIR}/runtime-api.js`,
        content: EMPTY_RUNTIME_SIDECAR,
    },
];
export const NPM_UPDATE_COMPAT_SIDECAR_PATHS = new Set(NPM_UPDATE_COMPAT_SIDECARS.map((entry) => entry.path));
export const NPM_UPDATE_OMITTED_BUNDLED_PLUGIN_ROOTS = new Set([
    `dist/extensions/${LEGACY_QA_CHANNEL_DIR}`,
    `dist/extensions/${LEGACY_QA_LAB_DIR}`,
    "dist/extensions/qa-matrix",
]);
