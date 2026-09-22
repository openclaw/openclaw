// Only external plugin work, disposable service discovery/policy and network health are fixtures. Keep
// the migrated worker, finishUpdate, ledger, native client/receiver and effects real.
import fs from "node:fs";
import { registerHooks } from "node:module";

const scratch = process.env.OPENCLAW_STATE_DIR!;
const source = (relative: string) =>
  new URL(
    import.meta.url.endsWith(".js") ? relative.replace(/\.ts$/u, ".js") : relative,
    import.meta.url,
  ).href;
// Consume fixture metadata before the real worker interprets its own arguments.
const runtimeEntry = process.argv.splice(2, 1)[0];
if (!runtimeEntry) {
  throw new Error("Legacy finalizer fixture requires its read-only worker declaration.");
}
const readOnlyEntrypoint: unknown = JSON.parse(runtimeEntry);
const overrides = new Map<string, string>([
  [
    source("../../infra/runtime-process-entrypoints.ts"),
    `import {runtimeProcessEntrypoints as actual} from ${JSON.stringify(source("../../infra/runtime-process-entrypoints.ts") + "?fixture-original")};
    export const runtimeProcessEntrypoints = {...actual, sqliteReadOnly: ${JSON.stringify(readOnlyEntrypoint)}};`,
  ],
  [
    source("./update-command-service-plan.ts"),
    `
    export function resolveGatewayServiceManagementBlockMessageForUpdate(env) {
      if(env.OPENCLAW_STATE_DIR!==${JSON.stringify(scratch)}) throw new Error("Non-fixture service environment");
      return undefined;
    }`,
  ],
  [
    source("./update-command-repair-service.ts"),
    `export async function repairUpdateService(p) { return p.result; }`,
  ],
  [
    source("../../infra/tmp-openclaw-dir.ts"),
    process.env.OPENCLAW_TEST_LEGACY_TEMP_FALLBACK === "1"
      ? `import {resolvePreferredOpenClawTmpDir as actual} from ${JSON.stringify(source("../../infra/tmp-openclaw-dir.ts") + "?fixture-original")};
         export function resolvePreferredOpenClawTmpDir() {
           return actual({preferredDir:${JSON.stringify(scratch + "/unavailable-preferred")}});
         }`
      : `export function resolvePreferredOpenClawTmpDir() {return ${JSON.stringify(scratch)};}`,
  ],
  [
    source("./update-command-convergence.ts"),
    `export async function convergeUpdatePlugins(p) {
    p.assertCurrent();
    return {resultWithPostUpdate:p.result,postUpdateConfigSnapshot:p.configSnapshot};
  }`,
  ],
  [
    source("./update-command-restart-context.ts"),
    `export async function prepareUpdateRestart() {
    return {refreshGatewayServiceEnv:false,serviceMutationAllowed:true,gatewayPort:19305,
      serviceUpdateVerdict:{kind:"unresolved"},skipLegacyServiceRestart:false};
  }`,
  ],
  [
    source("../../daemon/gateway-entrypoint.ts"),
    `export async function resolveGatewayInstallEntrypoint() { return ${JSON.stringify(scratch + "/native-entry.mjs")}; }`,
  ],
  [
    source("./update-command-verification.ts"),
    `
    export async function verifyUpdatedGateway(p) {
      p.assertCurrent();
      const fs=await import("node:fs");
      if(fs.readFileSync(${JSON.stringify(scratch + "/native-effect")},"utf8")!=="restarted") throw new Error("Native completion missing");
      return {ok:true};
    }`,
  ],
  [
    source("./shared.ts"),
    `
    export async function tryWriteCompletionCache() { return false; }`,
  ],
]);
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
fs.writeFileSync(scratch + "/finalizer-pid", String(process.pid));
await import("../../infra/update-migrated-finalize.worker.js");
