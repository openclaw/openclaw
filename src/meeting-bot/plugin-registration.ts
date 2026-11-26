import type { OpenClawPluginApi } from "../plugins/plugin-api.types.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import {
  createMeetingTranscriptSourceProvider,
  type MeetingTranscriptSourceRuntime,
} from "./transcripts-bridge.js";

type MeetingRegistrationRuntime = Partial<MeetingTranscriptSourceRuntime> & {
  reconcileTranscriptPolicy?(enabled: boolean): Promise<void>;
};

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
  const load = createLazyPromise(async () => {
    runtime = await options.createRuntime({ api, config });
    return runtime;
  });
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
  const ensureRuntime = async () => {
    if (!config.enabled) {
      throw new Error(options.disabledMessage);
    }
    const current = await load();
    // A reload may arrive while the first caller is waiting. All callers must observe its policy.
    for (;;) {
      const transition = policy ?? reconcile(enabled);
      await transition;
      if (transition === policy) {
        return current;
      }
    }
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
          if (!current.startTranscriptSource || !current.stopTranscriptSource) {
            throw new Error(`${options.name} transcript source runtime is unavailable`);
          }
          return current as MeetingTranscriptSourceRuntime;
        },
      }),
    );
  }
  return ensureRuntime;
}
