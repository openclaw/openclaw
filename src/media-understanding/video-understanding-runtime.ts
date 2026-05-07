import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadVideoUnderstandingRuntime = createLazyRuntimeModule(
  () => import("./video-understanding.js"),
);
const bindVideoUnderstandingRuntime = createLazyRuntimeMethodBinder(loadVideoUnderstandingRuntime);

export const understandVideoWithModel = bindVideoUnderstandingRuntime(
  (runtime) => runtime.understandVideoWithModel,
);
