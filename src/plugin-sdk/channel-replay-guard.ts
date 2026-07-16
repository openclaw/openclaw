import type {
  ClaimableDedupe,
  ClaimableDedupeOptions,
  PersistentDedupeCheckOptions,
} from "./persistent-dedupe.js";

type ReplayKeys = string | readonly (string | null | undefined)[] | null | undefined;

type ChannelReplayClaimResult =
  | { kind: "claimed"; keys: [string, ...string[]] }
  | { kind: "duplicate" }
  | { kind: "inflight"; pending: Promise<boolean> }
  | { kind: "invalid" };

type ChannelReplayProcessResult<T> =
  | { kind: "processed"; value: T }
  | { kind: "duplicate" }
  | { kind: "inflight"; pending: Promise<boolean> };

type ChannelReplayErrorMode = "commit" | "release";

type ChannelReplayProcessOptions = {
  dedupe?: PersistentDedupeCheckOptions;
  onError?: ChannelReplayErrorMode | ((error: unknown) => ChannelReplayErrorMode);
};

export type ChannelReplayGuardParams<TEvent> = {
  dedupe: ClaimableDedupeOptions;
  buildReplayKey: (event: TEvent) => ReplayKeys;
  namespace?: (event: TEvent) => string | undefined;
};

export type ChannelReplayGuard<TEvent> = {
  claim: (
    event: TEvent,
    options?: PersistentDedupeCheckOptions,
  ) => Promise<ChannelReplayClaimResult>;
  commit: (event: TEvent, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  release: (
    event: TEvent,
    options?: {
      namespace?: string;
      error?: unknown;
    },
  ) => void;
  shouldProcess: (event: TEvent, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  processGuarded: <T>(
    event: TEvent,
    process: () => Promise<T>,
    options?: ChannelReplayProcessOptions,
  ) => Promise<ChannelReplayProcessResult<T>>;
  hasRecent: (event: TEvent, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  forget: (event: TEvent, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
  clearMemory: () => void;
};

function normalizeReplayKeys(value: ReplayKeys): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .map((key) => key?.trim())
        .filter((key): key is string => Boolean(key)),
    ),
  ];
}

export function createChannelReplayGuardWithDedupe<TEvent>(
  params: Omit<ChannelReplayGuardParams<TEvent>, "dedupe">,
  dedupe: ClaimableDedupe & Required<Pick<ClaimableDedupe, "forget">>,
): ChannelReplayGuard<TEvent> {
  const resolveKeys = (event: TEvent) => normalizeReplayKeys(params.buildReplayKey(event));
  const resolveOptions = (
    event: TEvent,
    options?: PersistentDedupeCheckOptions,
  ): PersistentDedupeCheckOptions | undefined => {
    if (options?.namespace !== undefined) {
      return options;
    }
    const namespace = params.namespace?.(event);
    return namespace === undefined ? options : { ...options, namespace };
  };
  const resolveReleaseOptions = (
    event: TEvent,
    options?: { namespace?: string; error?: unknown },
  ) => {
    if (options?.namespace !== undefined) {
      return options;
    }
    const namespace = params.namespace?.(event);
    return namespace === undefined ? options : { ...options, namespace };
  };

  const releaseKeys = (
    keys: readonly string[],
    options?: { namespace?: string; error?: unknown },
  ) => {
    for (const key of keys) {
      dedupe.release(key, options);
    }
  };

  const commitKeys = async (
    keys: readonly string[],
    options?: PersistentDedupeCheckOptions,
  ): Promise<boolean> => {
    const results = await Promise.all(keys.map((key) => dedupe.commit(key, options)));
    return results.some(Boolean);
  };

  const claim: ChannelReplayGuard<TEvent>["claim"] = async (event, options) => {
    const keys = resolveKeys(event);
    if (keys.length === 0) {
      return { kind: "invalid" };
    }
    const dedupeOptions = resolveOptions(event, options);
    const claimedKeys: string[] = [];
    const pending: Promise<boolean>[] = [];
    try {
      for (const key of keys) {
        const result = await dedupe.claim(key, dedupeOptions);
        if (result.kind === "claimed") {
          claimedKeys.push(key);
        } else if (result.kind === "inflight") {
          pending.push(result.pending);
        }
      }
    } catch (error) {
      releaseKeys(claimedKeys, { namespace: dedupeOptions?.namespace, error });
      throw error;
    }
    if (claimedKeys.length > 0) {
      return { kind: "claimed", keys: claimedKeys as [string, ...string[]] };
    }
    if (pending.length > 0) {
      const aggregate = Promise.all(pending).then((results) => results.some(Boolean));
      void aggregate.catch(() => {});
      return {
        kind: "inflight",
        pending: aggregate,
      };
    }
    return { kind: "duplicate" };
  };

  const commit: ChannelReplayGuard<TEvent>["commit"] = async (event, options) => {
    const keys = resolveKeys(event);
    return keys.length > 0 ? await commitKeys(keys, resolveOptions(event, options)) : false;
  };

  const release: ChannelReplayGuard<TEvent>["release"] = (event, options) => {
    releaseKeys(resolveKeys(event), resolveReleaseOptions(event, options));
  };

  return {
    claim,
    commit,
    release,
    shouldProcess: async (event, options) => {
      const result = await claim(event, options);
      if (result.kind === "invalid") {
        return true;
      }
      if (result.kind !== "claimed") {
        return false;
      }
      return await commitKeys(result.keys, resolveOptions(event, options));
    },
    processGuarded: async (event, process, options) => {
      const dedupeOptions = resolveOptions(event, options?.dedupe);
      const result = await claim(event, dedupeOptions);
      if (result.kind === "duplicate" || result.kind === "inflight") {
        return result;
      }
      if (result.kind === "invalid") {
        return { kind: "processed", value: await process() };
      }
      let value: Awaited<ReturnType<typeof process>>;
      try {
        value = await process();
      } catch (error) {
        const errorMode =
          typeof options?.onError === "function"
            ? options.onError(error)
            : (options?.onError ?? "release");
        if (errorMode === "commit") {
          await commitKeys(result.keys, dedupeOptions);
        } else {
          releaseKeys(result.keys, { namespace: dedupeOptions?.namespace, error });
        }
        throw error;
      }
      await commitKeys(result.keys, dedupeOptions);
      return { kind: "processed", value };
    },
    hasRecent: async (event, options) => {
      const keys = resolveKeys(event);
      if (keys.length === 0) {
        return false;
      }
      const dedupeOptions = resolveOptions(event, options);
      const results = await Promise.all(keys.map((key) => dedupe.hasRecent(key, dedupeOptions)));
      return results.some(Boolean);
    },
    forget: async (event, options) => {
      const keys = resolveKeys(event);
      if (keys.length === 0) {
        return false;
      }
      const dedupeOptions = resolveOptions(event, options);
      const results = await Promise.all(keys.map((key) => dedupe.forget(key, dedupeOptions)));
      return results.some(Boolean);
    },
    warmup: dedupe.warmup,
    clearMemory: dedupe.clearMemory,
  };
}
