/**
 * Plugin-SDK entrypoint for the shared progress-lane engine.
 *
 * Flat re-export of the `progress-lane/` engine so it fits the plugin-sdk export
 * convention (one `src/plugin-sdk/<name>.ts` per `./plugin-sdk/<name>` subpath).
 * Channels import the engine from `openclaw/plugin-sdk/progress-lane`.
 */
export * from "./progress-lane/index.js";
