import type { SkillRouter } from "./router-types.js";

type SkillRouterFactory = (config: Record<string, unknown>) => SkillRouter;

const registry = new Map<string, SkillRouterFactory>();

/**
 * Register a skill router implementation.
 * Plugins call this at install time to declare which router they provide.
 *
 * @example
 * registerSkillRouter("my-router", (config) => new MyRouter(config));
 */
export function registerSkillRouter(name: string, factory: SkillRouterFactory): void {
  registry.set(name, factory);
}

/**
 * Resolve a registered skill router by name.
 * Returns null if no router with that name is registered.
 */
export function resolveSkillRouter(
  name: string,
  config?: Record<string, unknown>,
): SkillRouter | null {
  const factory = registry.get(name);
  return factory ? factory(config ?? {}) : null;
}

/**
 * List all registered skill router names.
 * Useful for diagnostics and `openclaw skills check`.
 */
export function listRegisteredSkillRouters(): string[] {
  return Array.from(registry.keys());
}
