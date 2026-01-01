import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { runInteractiveOnboarding } from "./onboard-interactive.js";
import { runNonInteractiveOnboarding } from "./onboard-non-interactive.js";
import type { OnboardOptions } from "./onboard-types.js";

export async function onboardCommand(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  assertSupportedRuntime(runtime);

  if (opts.nonInteractive) {
    await runNonInteractiveOnboarding(opts, runtime);
    return;
  }

  await runInteractiveOnboarding(opts, runtime);
}

export type { OnboardOptions } from "./onboard-types.js";
