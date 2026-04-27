import type { OpenClawConfig } from "../config/types.js";
import type { ContextEngine } from "./types.js";
/**
 * A factory that creates a ContextEngine instance.
 * Supports async creation for engines that need DB connections etc.
 */
export type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationResult = {
    ok: true;
} | {
    ok: false;
    existingOwner: string;
};
type RegisterContextEngineForOwnerOptions = {
    allowSameOwnerRefresh?: boolean;
};
/**
 * Register a context engine implementation under an explicit trusted owner.
 */
export declare function registerContextEngineForOwner(id: string, factory: ContextEngineFactory, owner: string, opts?: RegisterContextEngineForOwnerOptions): ContextEngineRegistrationResult;
/**
 * Public SDK entry point for third-party registrations.
 *
 * This path is intentionally unprivileged: it cannot claim core-owned ids and
 * it cannot safely refresh an existing registration because the caller's
 * identity is not authenticated.
 */
export declare function registerContextEngine(id: string, factory: ContextEngineFactory): ContextEngineRegistrationResult;
/**
 * Return the factory for a registered engine, or undefined.
 */
export declare function getContextEngineFactory(id: string): ContextEngineFactory | undefined;
/**
 * List all registered engine ids.
 */
export declare function listContextEngineIds(): string[];
export declare function clearContextEnginesForOwner(owner: string): void;
/**
 * Resolve which ContextEngine to use based on plugin slot configuration.
 *
 * Resolution order:
 *   1. `config.plugins.slots.contextEngine` (explicit slot override)
 *   2. Default slot value ("legacy")
 *
 * Non-default engines that fail (unregistered, factory throw, or contract
 * violation) are logged and silently replaced by the default engine.
 * Throws only when the default engine itself cannot be resolved.
 */
export declare function resolveContextEngine(config?: OpenClawConfig): Promise<ContextEngine>;
export {};
