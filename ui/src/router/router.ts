import { lazyPageModule } from "./lazy-page.ts";
import type { MaybePromise, Route, RouteRecord, RouteHookOptions } from "./types.ts";

type InvalidateContext = {
  invalidate: () => void;
};

type RouterOptions<
  TRouteId extends string,
  TLoadContext,
  TRenderContext extends InvalidateContext,
> = {
  routes: readonly RouteRecord<TRouteId, TLoadContext, TRenderContext>[];
};

type RouteRun = {
  controller: AbortController;
};

type RunKind = "transition" | "load";

type RouteContextFactory<TLoadContext> = (signal: AbortSignal) => TLoadContext;

type RouteBeforeLoad<TLoadContext> = (
  context: TLoadContext,
  options: RouteHookOptions,
) => MaybePromise<void>;

function isPromiseLike(value: MaybePromise<void>): value is Promise<void> {
  return Boolean(value && typeof (value as Promise<void>).then === "function");
}

function shouldRun(options: RouteHookOptions): boolean {
  return !options.signal.aborted && options.shouldRun();
}

export function normalizeRouteBasePath(basePath: string): string {
  if (!basePath) {
    return "";
  }
  let base = basePath.trim();
  if (!base.startsWith("/")) {
    base = `/${base}`;
  }
  if (base === "/") {
    return "";
  }
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function normalizeRoutePath(path: string): string {
  if (!path) {
    return "/";
  }
  let normalized = path.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function routePathKey(path: string): string {
  return normalizeRoutePath(path).toLowerCase();
}

function resolvePath(pathname: string, basePath: string): string {
  const base = normalizeRouteBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = routePathKey(path);
  if (normalized.endsWith("/index.html")) {
    normalized = "/";
  }
  return normalized;
}

function createRoutePathIndex<TRouteId extends string>(
  routes: readonly RouteRecord<TRouteId, unknown, InvalidateContext>[],
  defaultRouteId: TRouteId | null,
) {
  const byPath = new Map<string, TRouteId>();
  const canonicalPathById = new Map<TRouteId, string>();

  for (const route of routes) {
    const canonicalPath = normalizeRoutePath(route.path);
    canonicalPathById.set(route.id, canonicalPath);
    for (const path of [canonicalPath, ...(route.aliases ?? [])]) {
      const key = routePathKey(path);
      const existing = byPath.get(key);
      if (existing && existing !== route.id) {
        throw new Error(`Duplicate route path "${path}".`);
      }
      byPath.set(key, route.id);
    }
  }

  const routeIdFromPath = (pathname: string, basePath = ""): TRouteId | null => {
    const path = resolvePath(pathname, basePath);
    if (path === "/" && defaultRouteId) {
      return defaultRouteId;
    }
    return byPath.get(path) ?? null;
  };

  return {
    pathForRoute(routeId: TRouteId, basePath = ""): string {
      const path = canonicalPathById.get(routeId);
      if (!path) {
        throw new Error(`Unknown route id "${routeId}".`);
      }
      const base = normalizeRouteBasePath(basePath);
      return base ? `${base}${path}` : path;
    },
    routeIdFromPath,
    inferBasePathFromPathname(pathname: string): string {
      let normalized = normalizeRoutePath(pathname);
      if (normalized.endsWith("/index.html")) {
        normalized = normalizeRoutePath(normalized.slice(0, -"/index.html".length));
      }
      if (normalized === "/") {
        return "";
      }
      const segments = normalized.split("/").filter(Boolean);
      for (let i = 0; i < segments.length; i++) {
        if (byPath.has(routePathKey(`/${segments.slice(i).join("/")}`))) {
          const prefix = segments.slice(0, i);
          return prefix.length ? `/${prefix.join("/")}` : "";
        }
      }
      return `/${segments.join("/")}`;
    },
  };
}

export function createRouter<
  TRouteId extends string,
  TLoadContext = unknown,
  TRenderContext extends InvalidateContext = InvalidateContext,
>(
  options: RouterOptions<TRouteId, TLoadContext, TRenderContext> & {
    defaultRouteId?: TRouteId;
  },
) {
  const byId = new Map<TRouteId, Route<TRouteId, TLoadContext, TRenderContext>>();
  const routes = options.routes.map((route) => ({
    ...route,
    ...(route.page ? lazyPageModule(route.page) : {}),
  }));
  const paths = createRoutePathIndex(
    options.routes as readonly RouteRecord<TRouteId, unknown, InvalidateContext>[],
    options.defaultRouteId ?? null,
  );

  for (const route of routes) {
    if (byId.has(route.id)) {
      throw new Error(`Duplicate route id "${route.id}".`);
    }
    byId.set(route.id, route);
  }

  const runHook = (
    id: TRouteId,
    hook: "load" | "onEnter" | "onLeave",
    context: TLoadContext,
    options: RouteHookOptions,
  ): MaybePromise<void> => {
    if (!shouldRun(options)) {
      return;
    }
    return byId.get(id)?.[hook]?.(context, options);
  };

  const transitionRoute = (
    from: TRouteId,
    to: TRouteId,
    context: TLoadContext,
    options: RouteHookOptions,
  ): MaybePromise<void> => {
    const enter = () => {
      if (!shouldRun(options)) {
        return;
      }
      return runHook(to, "onEnter", context, options);
    };
    const leaveResult = runHook(from, "onLeave", context, options);
    if (isPromiseLike(leaveResult)) {
      return leaveResult.then(() => enter());
    }
    return enter();
  };

  const createRunner = () => {
    let transitionRun: RouteRun | null = null;
    let loadRun: RouteRun | null = null;

    const runFor = (kind: RunKind) => (kind === "transition" ? transitionRun : loadRun);
    const setRun = (kind: RunKind, run: RouteRun | null) => {
      if (kind === "transition") {
        transitionRun = run;
      } else {
        loadRun = run;
      }
    };
    const isCurrent = (kind: RunKind, run: RouteRun) =>
      runFor(kind) === run && !run.controller.signal.aborted;
    const begin = (kind: RunKind) => {
      runFor(kind)?.controller.abort();
      const run = { controller: new AbortController() };
      setRun(kind, run);
      return run;
    };
    const finish = (kind: RunKind, run: RouteRun) => {
      if (!isCurrent(kind, run)) {
        return;
      }
      setRun(kind, null);
    };
    const optionsFor = (kind: RunKind, run: RouteRun): RouteHookOptions => ({
      signal: run.controller.signal,
      shouldRun: () => isCurrent(kind, run),
    });
    const settle = (
      kind: RunKind,
      run: RouteRun,
      result: MaybePromise<void>,
    ): MaybePromise<void> => {
      if (!isPromiseLike(result)) {
        finish(kind, run);
        return;
      }
      return result.then(
        () => finish(kind, run),
        (error: unknown) => {
          const current = isCurrent(kind, run);
          finish(kind, run);
          if (!current) {
            return;
          }
          throw error;
        },
      );
    };

    return {
      cancel: () => {
        transitionRun?.controller.abort();
        loadRun?.controller.abort();
        transitionRun = null;
        loadRun = null;
      },
      enter(routeId: TRouteId, contextFor: RouteContextFactory<TLoadContext>): MaybePromise<void> {
        const run = begin("transition");
        return settle(
          "transition",
          run,
          runHook(
            routeId,
            "onEnter",
            contextFor(run.controller.signal),
            optionsFor("transition", run),
          ),
        );
      },
      load(
        routeId: TRouteId,
        contextFor: RouteContextFactory<TLoadContext>,
        beforeLoad?: RouteBeforeLoad<TLoadContext>,
      ): MaybePromise<void> {
        const run = begin("load");
        const context = contextFor(run.controller.signal);
        const options = optionsFor("load", run);
        const loadRoute = () =>
          isCurrent("load", run) ? runHook(routeId, "load", context, options) : undefined;
        try {
          const beforeLoadResult = beforeLoad?.(context, options);
          if (isPromiseLike(beforeLoadResult)) {
            return settle(
              "load",
              run,
              beforeLoadResult.then(() => loadRoute()),
            );
          }
          return settle("load", run, loadRoute());
        } catch (error) {
          finish("load", run);
          return Promise.reject(error);
        }
      },
      transition(
        from: TRouteId,
        to: TRouteId,
        contextFor: RouteContextFactory<TLoadContext>,
      ): MaybePromise<void> {
        const run = begin("transition");
        if (from === to) {
          finish("transition", run);
          return;
        }
        return settle(
          "transition",
          run,
          transitionRoute(
            from,
            to,
            contextFor(run.controller.signal),
            optionsFor("transition", run),
          ),
        );
      },
    };
  };

  return {
    routes,
    getRoute: (id: TRouteId) => byId.get(id) ?? null,
    inferBasePathFromPathname: paths.inferBasePathFromPathname,
    pathForRoute: paths.pathForRoute,
    routeIdFromPath: paths.routeIdFromPath,
    matchPath: (path: string, basePath = "") => {
      const routeId = paths.routeIdFromPath(path, basePath);
      return routeId ? (byId.get(routeId) ?? null) : null;
    },
    createRunner,
  };
}
