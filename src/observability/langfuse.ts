import process from "node:process";
import { createSubsystemLogger } from "../logging.js";

const log = createSubsystemLogger("observability.langfuse");

type EnvLike = NodeJS.ProcessEnv;

type LangfuseClientLike = {
  trace: (params?: Record<string, unknown>) => LangfuseTraceLike;
  flushAsync?: () => Promise<void>;
  shutdownAsync?: () => Promise<void>;
};

type LangfuseTraceLike = {
  update?: (params?: Record<string, unknown>) => unknown;
  span?: (params?: Record<string, unknown>) => LangfuseObservationLike;
  generation?: (params?: Record<string, unknown>) => LangfuseObservationLike;
};

type LangfuseObservationLike = {
  update?: (params?: Record<string, unknown>) => unknown;
  end?: (params?: Record<string, unknown>) => unknown;
  span?: (params?: Record<string, unknown>) => LangfuseObservationLike;
  generation?: (params?: Record<string, unknown>) => LangfuseObservationLike;
};

export type LangfuseConfig = {
  enabled: boolean;
  host?: string;
  publicKey?: string;
  /** secretKey is intentionally omitted from the exported shape to avoid accidental exposure. */
  configured: boolean;
};

export type LangfuseHandle = {
  readonly enabled: boolean;
  readonly kind: "trace" | "span" | "generation";
  update: (params?: Record<string, unknown>) => void;
  end: (params?: Record<string, unknown>) => void;
  captureError: (error: unknown, extra?: Record<string, unknown>) => void;
  span: (params?: Record<string, unknown>) => LangfuseHandle;
  generation: (params?: Record<string, unknown>) => LangfuseHandle;
};

export type LangfuseInstrumentation = {
  readonly enabled: boolean;
  readonly config: LangfuseConfig;
  startTrace: (params?: Record<string, unknown>) => LangfuseHandle;
  captureError: (error: unknown, extra?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
};

const noopHandle = (kind: LangfuseHandle["kind"]): LangfuseHandle => ({
  enabled: false,
  kind,
  update: () => {},
  end: () => {},
  captureError: () => {},
  span: () => noopHandle("span"),
  generation: () => noopHandle("generation"),
});

const noopInstrumentation: LangfuseInstrumentation = {
  enabled: false,
  config: { enabled: false, configured: false },
  startTrace: () => noopHandle("trace"),
  captureError: () => {},
  flush: async () => {},
  shutdown: async () => {},
};

let instrumentationPromise: Promise<LangfuseInstrumentation> | null = null;

function parseEnabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function readLangfuseConfig(env: EnvLike = process.env): LangfuseConfig {
  const enabled = parseEnabled(env.LANGFUSE_ENABLED);
  const host = env.LANGFUSE_HOST?.trim() || undefined;
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim() || undefined;
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim() || undefined;
  const configured = Boolean(host && publicKey && secretKey);
  return { enabled, host, publicKey, configured };
}

function toErrorString(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function createHandle(
  kind: LangfuseHandle["kind"],
  node: LangfuseTraceLike | LangfuseObservationLike,
): LangfuseHandle {
  return {
    enabled: true,
    kind,
    update: (params) => {
      node.update?.(params);
    },
    end: (params) => {
      if (kind === "trace") {
        node.update?.(params);
        return;
      }
      (node as LangfuseObservationLike).end?.(params);
    },
    captureError: (error, extra) => {
      const payload = {
        ...extra,
        level: "ERROR",
        statusMessage: toErrorString(error),
      };
      if (kind === "trace") {
        node.update?.(payload);
        return;
      }
      (node as LangfuseObservationLike).end?.(payload);
    },
    span: (params) => {
      const child = node.span?.(params);
      return child ? createHandle("span", child) : noopHandle("span");
    },
    generation: (params) => {
      const child = node.generation?.(params);
      return child ? createHandle("generation", child) : noopHandle("generation");
    },
  };
}

async function buildInstrumentation(env: EnvLike): Promise<LangfuseInstrumentation> {
  const config = readLangfuseConfig(env);
  if (!config.enabled) {
    log.debug("Langfuse disabled via env; using no-op instrumentation");
    return { ...noopInstrumentation, config };
  }
  if (!config.configured) {
    log.warn("Langfuse enabled but configuration incomplete; falling back to no-op mode", {
      hostConfigured: Boolean(config.host),
      publicKeyConfigured: Boolean(config.publicKey),
      secretKeyConfigured: Boolean(env.LANGFUSE_SECRET_KEY?.trim()),
    });
    return { ...noopInstrumentation, config };
  }

  try {
    const { Langfuse } = await import("langfuse");
    const client = new Langfuse({
      enabled: true,
      baseUrl: config.host,
      publicKey: config.publicKey,
      secretKey: env.LANGFUSE_SECRET_KEY?.trim(),
    }) as LangfuseClientLike;
    log.info("Langfuse client initialized", { host: config.host });
    return {
      enabled: true,
      config,
      startTrace: (params) => createHandle("trace", client.trace(params)),
      captureError: (error, extra) => {
        log.warn("Langfuse top-level error captured", {
          error: toErrorString(error),
          ...extra,
        });
      },
      flush: async () => {
        await client.flushAsync?.();
      },
      shutdown: async () => {
        await client.shutdownAsync?.();
      },
    };
  } catch (error) {
    log.error("Langfuse initialization failed; falling back to no-op mode", {
      error: toErrorString(error),
    });
    return { ...noopInstrumentation, config };
  }
}

export function initializeLangfuse(env: EnvLike = process.env): Promise<LangfuseInstrumentation> {
  instrumentationPromise ??= buildInstrumentation(env);
  return instrumentationPromise;
}

export async function getLangfuseInstrumentation(): Promise<LangfuseInstrumentation> {
  return initializeLangfuse(process.env);
}

export async function startLangfuseTrace(
  params?: Record<string, unknown>,
): Promise<LangfuseHandle> {
  const instrumentation = await getLangfuseInstrumentation();
  return instrumentation.startTrace(params);
}

export function resetLangfuseInstrumentationForTests(): void {
  instrumentationPromise = null;
}
