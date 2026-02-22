import { runPipeline } from "./pipeline.engine.js";
import { loadPipelineSpec } from "./pipeline.spec.js";

type RunOpts = {
  phase?: string;
  until?: string;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

export async function runPipelineCommand(params: { specPath: string; opts: RunOpts }) {
  const spec = loadPipelineSpec(params.specPath);
  const summary = await runPipeline(spec, {
    phase: params.opts.phase,
    until: params.opts.until,
    yes: params.opts.yes,
    dryRun: params.opts.dryRun,
  });

  if (params.opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
  }
}
