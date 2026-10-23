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
// their definitions would leave external custom elements permanently unupgraded.

import {
  isRepoOwnedRegistrationStack,
  jsdomCustomElementDefinitions,
  type JsdomCustomElementDefinition,
} from "./jsdom-compat.mts";

export { jsdomCustomElementDefinitions };

export type CustomElementTracking = {
  registry: CustomElementRegistry;
  definitions: JsdomCustomElementDefinition[];
  repoOwnedTags: Set<string>;
};

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
    const stack = new Error().stack;
    if (isRepoOwnedRegistrationStack(stack)) {
      tracking.repoOwnedTags.add(name);
    }
    try {
      define(name, constructor, options);
    } catch (error) {
      // Bun's native DOMException can omit the caller stack from collection failures.
      console.error("[jsdom-custom-elements:registration-failed]", {
        tag: name.slice(0, 160),
        alreadyDefined: Boolean(registry.get(name)),
        trackedForCleanup: tracking.repoOwnedTags.has(name),
        stack: stack
          ?.split("\n")
          .slice(0, 8)
          .map((line) => line.slice(0, 400)),
      });
      throw error;
    }
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
