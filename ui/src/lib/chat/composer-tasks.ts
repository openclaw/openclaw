// The composer task owner loads with the first plugin composer action, outside the chat boot
// bundle.
type ComposerTasksRuntime = typeof import("./composer-tasks.runtime.ts");

let loading: Promise<ComposerTasksRuntime> | undefined;

export function loadComposerTasksRuntime(): Promise<ComposerTasksRuntime> {
  return (loading ??= import("./composer-tasks.runtime.ts").catch((error: unknown) => {
    // A failed chunk fetch is not cached, so the next action tries again.
    loading = undefined;
    throw error;
  }));
}
