// Jsdom custom elements keeps shared-worker element registrations in step with the module graph.
//
// Shared (isolate: false) jsdom lanes re-evaluate the module graph for every test
// file, so each file gets freshly evaluated component classes. jsdom keeps custom
// element definitions on the window instead, outside that graph. A definition
// surviving the reset can reject registration or pin a tag to the previous file's
// class. The next file's `document.createElement(tag)` then closes over the earlier file's
// module instances, and its own singletons, module mocks, and spies are never the
// ones production reaches. Registry lifetime has to match graph lifetime.
//
// Only repo-owned tags may be dropped. Dependency packages are externalized, so
// they evaluate once per worker through native ESM and never re-register; dropping
// their definitions would leave `wa-*` and friends permanently unupgraded.

import {
  jsdomCustomElementDefinitions,
  type JsdomCustomElementDefinition,
} from "./jsdom-compat.mts";

export { jsdomCustomElementDefinitions };

export type CustomElementTracking = {
  registry: CustomElementRegistry;
  definitions: JsdomCustomElementDefinition[];
  repoOwnedTags: Set<string>;
};

const VITEST_SPY_FRAME = /[\\/]node_modules[\\/]vitest[\\/]dist[\\/]chunks[\\/]spy\.[^\\/]+\.js:/u;

// Conservative on an unreadable stack: keeping a repo tag costs a stale class in
// one lane, dropping a dependency tag would leave it unupgraded for the whole run.
export function isRepoOwnedDefineStack(stack: string | undefined): boolean {
  const frames = (stack ?? "").split("\n").slice(2);
  // A Vitest spy on define forwards here, possibly through a fixture's mock
  // implementation. Neither owns the registered class; whoever called the spy does.
  const spyFrame = frames.findIndex((frame) => VITEST_SPY_FRAME.test(frame));
  const callerFrame =
    frames.slice(spyFrame + 1).find((frame) => !VITEST_SPY_FRAME.test(frame)) ?? "";
  return callerFrame.trim() !== "" && !/[\\/]node_modules[\\/]/u.test(callerFrame);
}

// Returns undefined for anything that is not a jsdom registry: mixed lanes run
// `@vitest-environment node` files whose leftover global has no definitions to track.
export function trackCustomElementRegistry(
  registry: CustomElementRegistry,
): CustomElementTracking | undefined {
  const definitions = jsdomCustomElementDefinitions(registry);
  if (!definitions) {
    return undefined;
  }
  const tracking: CustomElementTracking = { registry, definitions, repoOwnedTags: new Set() };
  const define = registry.define.bind(registry);
  registry.define = (name, constructor, options) => {
    if (isRepoOwnedDefineStack(new Error().stack)) {
      tracking.repoOwnedTags.add(name);
    }
    define(name, constructor, options);
  };
  return tracking;
}

export function dropRepoOwnedCustomElements(tracking: CustomElementTracking): void {
  if (tracking.repoOwnedTags.size === 0) {
    return;
  }
  const survivors = tracking.definitions.filter(
    (definition) => !tracking.repoOwnedTags.has(definition.name),
  );
  tracking.definitions.length = 0;
  tracking.definitions.push(...survivors);
  tracking.repoOwnedTags.clear();
}
