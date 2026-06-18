import { createLazyView, renderLazyView, type LazyView } from "../ui/lazy-view.ts";
import type { PageModule, RouteHookOptions } from "./types.ts";

type InvalidateContext = {
  invalidate: () => void;
};

export function lazyPage<TModule, TContext extends InvalidateContext>(
  loader: () => Promise<TModule>,
  render: (module: TModule, context: TContext) => unknown,
): (context: TContext) => unknown {
  const views = new WeakMap<() => void, LazyView<TModule>>();
  return (context) => {
    let view = views.get(context.invalidate);
    if (!view) {
      view = createLazyView<TModule>(loader, context.invalidate);
      views.set(context.invalidate, view);
    }
    return renderLazyView(view, (module) => render(module, context));
  };
}

export function lazyPageModule<TLoadContext, TRenderContext extends InvalidateContext>(
  loader: () => Promise<PageModule<TLoadContext, TRenderContext>>,
) {
  let module: PageModule<TLoadContext, TRenderContext> | null = null;
  let promise: Promise<PageModule<TLoadContext, TRenderContext>> | null = null;
  const load = () => {
    if (module) {
      return Promise.resolve(module);
    }
    promise ??= loader().then(
      (next) => {
        module = next;
        promise = null;
        return next;
      },
      (error: unknown) => {
        promise = null;
        throw error;
      },
    );
    return promise;
  };
  return {
    onEnter: async (context: TLoadContext, options: RouteHookOptions) => {
      const module = await load();
      return options.shouldRun() ? module.page.onEnter?.(context, options) : undefined;
    },
    load: async (context: TLoadContext, options: RouteHookOptions) => {
      const module = await load();
      return options.shouldRun() ? module.page.load?.(context, options) : undefined;
    },
    onLeave: async (context: TLoadContext, options: RouteHookOptions) => {
      const module = await load();
      return options.shouldRun() ? module.page.onLeave?.(context, options) : undefined;
    },
    render: lazyPage<PageModule<TLoadContext, TRenderContext>, TRenderContext>(
      load,
      (module, context) => module.page.render(context),
    ),
  };
}
