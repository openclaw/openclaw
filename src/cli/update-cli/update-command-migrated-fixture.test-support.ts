import { registerHooks } from "node:module";
import { MIGRATED_FIXTURE_NO_SERVICE } from "./update-command-migrated-fixture-entrypoint.test-support.js";

const scratch = process.env.OPENCLAW_STATE_DIR;
const runtimeEntry = process.argv.splice(2, 1)[0];
if (!scratch || !runtimeEntry) {
  throw new Error(
    "Migrated finalization fixture requires isolated state and its read-only worker.",
  );
}
const readOnlyEntrypoint: unknown = JSON.parse(runtimeEntry);
const source = (relative: string) =>
  new URL(
    import.meta.url.endsWith(".js") ? relative.replace(/\.ts$/u, ".js") : relative,
    import.meta.url,
  ).href;
const overrides = new Map([
  [
    source("../../infra/runtime-process-entrypoints.ts"),
    `import {runtimeProcessEntrypoints as actual} from ${JSON.stringify(source("../../infra/runtime-process-entrypoints.ts") + "?fixture-original")};
     export const runtimeProcessEntrypoints = {...actual, sqliteReadOnly: ${JSON.stringify(readOnlyEntrypoint)}};`,
  ],
  [
    source("./update-command-service-plan.ts"),
    `export async function readManagedGatewayServiceForUpdate(env) {
       if (env.OPENCLAW_STATE_DIR !== ${JSON.stringify(scratch)}) throw new Error("Non-fixture service environment");
       throw new Error(${JSON.stringify(MIGRATED_FIXTURE_NO_SERVICE)});
     }`,
  ],
]);
// Keep the candidate, executor delegation, recovery recording, and terminal ledger real.
// This fencing fixture owns no native service; probing the host can outlive its test.
registerHooks({
  load(url, context, nextLoad) {
    const replacement = overrides.get(url);
    return replacement === undefined
      ? nextLoad(url, context)
      : {
          format: "module",
          source: `export * from ${JSON.stringify(url + "?fixture-original")};\n${replacement}`,
          shortCircuit: true,
        };
  },
});
await import("../../infra/update-migrated-finalize.worker.js");
