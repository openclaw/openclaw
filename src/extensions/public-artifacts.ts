export const BUNDLED_RUNTIME_SIDECAR_PATHS = [
  "dist/extensions/whatsapp/light-runtime-api.js",
  "dist/extensions/whatsapp/runtime-api.js",
  "dist/extensions/matrix/helper-api.js",
  "dist/extensions/matrix/runtime-api.js",
  "dist/extensions/matrix/thread-bindings-runtime.js",
  "dist/extensions/msteams/runtime-api.js",
] as const;

const EXTRA_GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES = [
  "action-runtime.runtime.js",
  "action-runtime-api.js",
  "allow-from.js",
  "api.js",
  "auth-presence.js",
  "index.js",
  "login-qr-api.js",
  "onboard.js",
  "openai-codex-catalog.js",
  "provider-catalog.js",
  "session-key-api.js",
  "setup-api.js",
  "setup-entry.js",
  "timeouts.js",
] as const;

export const GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES = [
  ...new Set([
    ...BUNDLED_RUNTIME_SIDECAR_PATHS.map(
      (relativePath) => relativePath.split("/").at(-1) ?? relativePath,
    ),
    ...EXTRA_GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES,
  ]),
] as const;
