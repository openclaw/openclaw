/** Drain the same acquisition steps for synchronous CLI and lazy module callbacks. */
export function drainPluginGenerationSteps<T>(steps: Generator<void, T, void>): T {
  let step = steps.next();
  while (!step.done) {
    step = steps.next();
  }
  return step.value;
}
