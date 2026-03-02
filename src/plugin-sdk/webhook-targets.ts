import type { IncomingMessage, ServerResponse } from "node:http";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { normalizeWebhookPath } from "./webhook-path.js";

export type RegisteredWebhookTarget<T> = {
  target: T;
  unregister: () => void;
};

export type RegisterWebhookTargetOptions<T extends { path: string }> = {
  onFirstPathTarget?: (params: { path: string; target: T }) => void | (() => void);
  onLastPathTargetRemoved?: (params: { path: string }) => void;
};

type RegisterPluginHttpRouteParams = Parameters<typeof registerPluginHttpRoute>[0];

export type RegisterWebhookPluginRouteOptions = Omit<
  RegisterPluginHttpRouteParams,
  "path" | "fallbackPath"
>;

export function registerWebhookTargetWithPluginRoute<T extends { path: string }>(params: {
  targetsByPath: Map<string, T[]>;
  target: T;
  route: RegisterWebhookPluginRouteOptions;
  onLastPathTargetRemoved?: RegisterWebhookTargetOptions<T>["onLastPathTargetRemoved"];
}): RegisteredWebhookTarget<T> {
  return registerWebhookTarget(params.targetsByPath, params.target, {
    onFirstPathTarget: ({ path }) =>
      registerPluginHttpRoute({
        ...params.route,
        path,
        replaceExisting: params.route.replaceExisting ?? true,
      }),
    onLastPathTargetRemoved: params.onLastPathTargetRemoved,
  });
}

const pathTeardownByTargetMap = new WeakMap<Map<string, unknown[]>, Map<string, () => void>>();

function getPathTeardownMap<T>(targetsByPath: Map<string, T[]>): Map<string, () => void> {
  const mapKey = targetsByPath as unknown as Map<string, unknown[]>;
  const existing = pathTeardownByTargetMap.get(mapKey);
  if (existing) {
    return existing;
  }
  const created = new Map<string, () => void>();
  pathTeardownByTargetMap.set(mapKey, created);
  return created;
}

export function registerWebhookTarget<T extends { path: string }>(
  targetsByPath: Map<string, T[]>,
  target: T,
  opts?: RegisterWebhookTargetOptions<T>,
): RegisteredWebhookTarget<T> {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = targetsByPath.get(key) ?? [];

  if (existing.length === 0) {
    const onFirstPathResult = opts?.onFirstPathTarget?.({
      path: key,
      target: normalizedTarget,
    });
    if (typeof onFirstPathResult === "function") {
      getPathTeardownMap(targetsByPath).set(key, onFirstPathResult);
    }
  }

  targetsByPath.set(key, [...existing, normalizedTarget]);

  let isActive = true;
  const unregister = () => {
    if (!isActive) {
      return;
    }
    isActive = false;

    const updated = (targetsByPath.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      targetsByPath.set(key, updated);
      return;
    }
    targetsByPath.delete(key);

    const teardown = getPathTeardownMap(targetsByPath).get(key);
    if (teardown) {
      getPathTeardownMap(targetsByPath).delete(key);
      teardown();
    }
    opts?.onLastPathTargetRemoved?.({ path: key });
  };
  return { target: normalizedTarget, unregister };
}

export function resolveWebhookTargets<T>(
  req: IncomingMessage,
  targetsByPath: Map<string, T[]>,
): { path: string; targets: T[] } | null {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = targetsByPath.get(path);
  if (!targets || targets.length === 0) {
    return null;
  }
  return { path, targets };
}

export type WebhookTargetMatchResult<T> =
  | { kind: "none" }
  | { kind: "single"; target: T }
  | { kind: "ambiguous" };

export function resolveSingleWebhookTarget<T>(
  targets: readonly T[],
  isMatch: (target: T) => boolean,
): WebhookTargetMatchResult<T> {
  let matched: T | undefined;
  for (const target of targets) {
    if (!isMatch(target)) {
      continue;
    }
    if (matched) {
      return { kind: "ambiguous" };
    }
    matched = target;
  }
  if (!matched) {
    return { kind: "none" };
  }
  return { kind: "single", target: matched };
}

export async function resolveSingleWebhookTargetAsync<T>(
  targets: readonly T[],
  isMatch: (target: T) => Promise<boolean>,
): Promise<WebhookTargetMatchResult<T>> {
  let matched: T | undefined;
  for (const target of targets) {
    if (!(await isMatch(target))) {
      continue;
    }
    if (matched) {
      return { kind: "ambiguous" };
    }
    matched = target;
  }
  if (!matched) {
    return { kind: "none" };
  }
  return { kind: "single", target: matched };
}

export function rejectNonPostWebhookRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "POST") {
    return false;
  }
  res.statusCode = 405;
  res.setHeader("Allow", "POST");
  res.end("Method Not Allowed");
  return true;
}
