import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

type IngressRuntimeLogger = Pick<RuntimeEnv, "log" | "error">;

const logIngressWarn = (logger: IngressRuntimeLogger | undefined, text: string) => {
  logger?.error?.(text);
};

export type ChannelIngressMiddlewareConfig =
  | string
  | {
      name?: string;
      module: string;
      exportName?: string;
    };

export type ChannelIngressMiddlewareOutcome = {
  name: string;
  ok: boolean;
  durationMs: number;
  result?: unknown;
  error?: string;
};

export type ChannelIngressMiddlewareRunResult = {
  middlewareCount: number;
  outcomes: ChannelIngressMiddlewareOutcome[];
};

const toArray = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

export const normalizeChannelIngressMiddlewareEntry = (
  entry: ChannelIngressMiddlewareConfig,
  index: number,
): { name: string; module: string; exportName: string } | null => {
  if (typeof entry === "string") {
    return {
      name: `middleware-${index + 1}`,
      module: entry,
      exportName: "runIngressMiddleware",
    };
  }
  if (entry && typeof entry === "object" && typeof entry.module === "string") {
    return {
      name: entry.name?.trim() || `middleware-${index + 1}`,
      module: entry.module,
      exportName: entry.exportName?.trim() || "runIngressMiddleware",
    };
  }
  return null;
};

type ChannelIngressMiddlewareFn = (args: unknown) => unknown;

export async function resolveChannelIngressMiddlewareFunctions(
  entries: ChannelIngressMiddlewareConfig[] | undefined,
  logger?: IngressRuntimeLogger,
): Promise<Array<{ name: string; fn: ChannelIngressMiddlewareFn }>> {
  const resolved: Array<{ name: string; fn: ChannelIngressMiddlewareFn }> = [];
  for (const [index, rawEntry] of toArray(entries).entries()) {
    const entry = normalizeChannelIngressMiddlewareEntry(rawEntry, index);
    if (!entry) {
      logIngressWarn(logger, `ingress-runtime skip middleware[${index}] reason=invalid-entry`);
      continue;
    }
    try {
      const imported = await import(entry.module);
      const fn = imported?.[entry.exportName];
      if (typeof fn !== "function") {
        logIngressWarn(
          logger,
          `ingress-runtime skip middleware name=${entry.name} reason=missing-export export=${entry.exportName}`,
        );
        continue;
      }
      resolved.push({ name: entry.name, fn });
    } catch (err) {
      logIngressWarn(
        logger,
        `ingress-runtime skip middleware name=${entry.name} reason=import-failed err=${String(err)}`,
      );
    }
  }
  return resolved;
}

export async function runChannelIngressMiddlewares<TArgs>(params: {
  entries: ChannelIngressMiddlewareConfig[] | undefined;
  args: TArgs;
  logger?: IngressRuntimeLogger;
  resolveFns?: typeof resolveChannelIngressMiddlewareFunctions;
}): Promise<ChannelIngressMiddlewareRunResult> {
  const resolved = await (params.resolveFns ?? resolveChannelIngressMiddlewareFunctions)(
    params.entries,
    params.logger,
  );
  const outcomes: ChannelIngressMiddlewareOutcome[] = [];
  for (const middleware of resolved) {
    const startedAt = Date.now();
    try {
      const result = await middleware.fn(params.args);
      outcomes.push({
        name: middleware.name,
        ok: true,
        durationMs: Date.now() - startedAt,
        result,
      });
    } catch (err) {
      outcomes.push({
        name: middleware.name,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: String(err),
      });
      logIngressWarn(
        params.logger,
        `ingress-runtime middleware-failed name=${middleware.name} err=${String(err)}`,
      );
    }
  }
  return {
    middlewareCount: resolved.length,
    outcomes,
  };
}
