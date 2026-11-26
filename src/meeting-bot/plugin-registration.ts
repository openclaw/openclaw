import type { OpenClawPluginApi } from "../plugins/plugin-api.types.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import {
  createMeetingTranscriptSourceProvider,
  type MeetingTranscriptSourceRuntime,
} from "./transcripts-bridge.js";

type MeetingRegistrationRuntime = Partial<MeetingTranscriptSourceRuntime> & {
  reconcileTranscriptPolicy?(enabled: boolean): Promise<void>;
};

function hasTranscriptSourceMethods(
  runtime: MeetingRegistrationRuntime,
): runtime is MeetingTranscriptSourceRuntime {
  return (
    typeof runtime.startTranscriptSource === "function" &&
    typeof runtime.stopTranscriptSource === "function"
  );
}

/** Register one lazy runtime and its optional live-caption source for this plugin instance. */
export function registerMeetingPluginRuntime<
  Config extends { enabled: boolean },
  Runtime extends MeetingRegistrationRuntime,
>(
  api: OpenClawPluginApi,
  config: Config,
  options: {
    id: string;
    name: string;
    disabledMessage: string;
    createRuntime(params: { api: OpenClawPluginApi; config: Config }): Runtime | Promise<Runtime>;
    transcriptSource?: { id: string; name: string; aliases?: readonly string[] };
  },
): () => Promise<Runtime> {
  let enabled = api.config.transcripts?.enabled !== false;
  let runtime: Runtime | undefined;
  let policy: Promise<void> | undefined;
  const reconcile = (next: boolean) => {
    enabled = next;
    const transition = runtime?.reconcileTranscriptPolicy?.(next);
    policy = transition;
    // Retry a failed transition on the same runtime, unless a newer policy already replaced it.
    void transition?.catch(() => {
      if (policy === transition) {
        policy = undefined;
      }
    });
    return transition;
  };
  const initialize = createLazyPromise(async () => {
    runtime ??= await options.createRuntime({ api, config });
    // A reload can replace the initial policy while callers wait. Once published,
    // the runtime stays accessible so a later transcript drain cannot block leave.
    for (;;) {
      const transition = policy ?? reconcile(enabled);
      await transition;
      if (transition === policy) {
        return runtime;
      }
    }
  });
  const ensureRuntime = async () => {
    if (!config.enabled) {
      throw new Error(options.disabledMessage);
    }
    return await initialize();
  };
  if (options.transcriptSource) {
    api.registerService({
      id: `${options.id}-transcripts`,
      reload: { configPrefixes: ["transcripts.enabled"] },
      start: ({ config: current }) => reconcile(current.transcripts?.enabled !== false),
      stop: () => reconcile(false),
    });
    api.registerTranscriptSourceProvider(
      createMeetingTranscriptSourceProvider({
        ...options.transcriptSource,
        runtime: async () => {
          const current = await ensureRuntime();
          if (!hasTranscriptSourceMethods(current)) {
            throw new Error(`${options.name} transcript source runtime is unavailable`);
          }
          return current;
        },
      }),
    );
  }
  return ensureRuntime;
}
