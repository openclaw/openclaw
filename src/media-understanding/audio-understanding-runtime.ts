import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadAudioUnderstandingRuntime = createLazyRuntimeModule(
  () => import("./audio-understanding.js"),
);
const bindAudioUnderstandingRuntime = createLazyRuntimeMethodBinder(loadAudioUnderstandingRuntime);

export const understandAudioWithModel = bindAudioUnderstandingRuntime(
  (runtime) => runtime.understandAudioWithModel,
);
