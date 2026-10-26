import { registerHooks } from "node:module";
import { fixtureReceiptClientSource } from "../../../test/helpers/fixture-receipts.js";
import { MIGRATED_FIXTURE_NO_SERVICE } from "./update-command-migrated-fixture-entrypoint.test-support.js";

const scratch = process.env.OPENCLAW_STATE_DIR;
const runtimeEntry = process.argv.splice(2, 1)[0];
if (!scratch || !runtimeEntry) {
  throw new Error(
    "Migrated finalization fixture requires isolated state and its read-only worker.",
  );
}
const input: {
  readOnlyEntrypoint: unknown;
  replay?: { path: string; refuseStep?: string };
  progressGate?: string;
} = JSON.parse(runtimeEntry);
const { readOnlyEntrypoint, replay, progressGate } = input;
const source = (relative: string) =>
  new URL(
    import.meta.url.endsWith(".js") ? relative.replace(/\.ts$/u, ".js") : relative,
    import.meta.url,
  ).href;
const overrides = new Map<string, string>();
const replace = (file: string, contents: string) => overrides.set(source(file), contents);
let serviceImports = progressGate ? fixtureReceiptClientSource(progressGate) : "";
let serviceAction = `process.stderr.write('fixture-finalizer-progress\\n');
       ${progressGate ? "sendReceipt('finalizer', 'waiting'); await awaitRelease('finalizer', 'finish');" : ""}`;
replace(
  "../../infra/runtime-process-entrypoints.ts",
  `import {runtimeProcessEntrypoints as actual} from ${JSON.stringify(source("../../infra/runtime-process-entrypoints.ts") + "?fixture-original")};
     export const runtimeProcessEntrypoints = {...actual, sqliteReadOnly: ${JSON.stringify(readOnlyEntrypoint)}};`,
);
if (replay && process.argv[2] !== "--check") {
  // Observe real receipt settlement and refuse only the selected native commit.
  const control = `data:text/javascript,${encodeURIComponent(`
    import {AsyncLocalStorage} from 'node:async_hooks';
    import {appendFileSync} from 'node:fs';
    export const context = new AsyncLocalStorage();
    export const record = (event) => appendFileSync(${JSON.stringify(replay.path)}, JSON.stringify(event)+'\\n');
    export const refuseStep = ${JSON.stringify(replay.refuseStep ?? null)};
  `)}`;
  replace(
    "../../infra/update-run-write.async.ts",
    `import {recordUpdateRunStepAsync as actual} from ${JSON.stringify(source("../../infra/update-run-write.async.ts") + "?fixture-original")};
     import {context, record} from ${JSON.stringify(control)};
     export async function recordUpdateRunStepAsync(...args) {
       const step = args[1].step;
       if (!step.startsWith('receiver-')) return await actual(...args);
       return await context.run(step, async () => {
         record({event:'entered',step});
         try {
           const result = await actual(...args);
           record({event:'settled',step});
           return result;
         } catch (error) {
           record({event:'rejected',step});
           throw error;
         }
       });
     }`,
  );
  replace(
    "../../infra/sqlite-worker-store.ts",
    `import {createSqliteWorkerWriteAdmission as actual} from ${JSON.stringify(source("../../infra/sqlite-worker-store.ts") + "?fixture-original")};
     import {context, record, refuseStep} from ${JSON.stringify(control)};
     export function createSqliteWorkerWriteAdmission(assertCurrent, locations) {
       const step = context.getStore();
       return actual((request) => {
         assertCurrent(request);
         if (step) {
           record({event:request.stage,step});
           if (request.stage === 'commit' && step === refuseStep) {
             throw new Error('receiver replay commit refused');
           }
         }
       }, locations);
     }`,
  );
  serviceImports = `import {record} from ${JSON.stringify(control)};`;
  serviceAction = "record({event:'service'});";
}
replace(
  "./update-command-service-plan.ts",
  `${serviceImports}
     export async function readManagedGatewayServiceForUpdate(env) {
       if (env.OPENCLAW_STATE_DIR !== ${JSON.stringify(scratch)}) throw new Error("Non-fixture service environment");
       ${serviceAction}
       throw new Error(${JSON.stringify(MIGRATED_FIXTURE_NO_SERVICE)});
     }`,
);
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
