/**
 * Zod schema for safety posture configuration.
 * Issue #7827: Default Safety Posture - Sandbox & Session Isolation
 */

import { z } from "zod";

export const SafetyPosturePresetSchema = z.union([
  z.literal("development"),
  z.literal("balanced"),
  z.literal("strict"),
]);

export const AgentToolProfileSchema = z.union([
  z.literal("full"),
  z.literal("limited"),
  z.literal("public"),
]);

export const SafetyPostureConfigSchema = z
  .object({
    /**
     * Active safety posture preset.
     * - development: Permissive defaults (sandbox off)
     * - balanced: Moderate security (sandbox for non-main sessions)
     * - strict: Maximum isolation (sandbox all sessions)
     */
    preset: SafetyPosturePresetSchema.optional(),
    /**
     * Override the agent tool profile derived from preset.
     */
    agentProfile: AgentToolProfileSchema.optional(),
    /**
     * Enable secure DM mode (per-channel-peer isolation).
     */
    secureDmMode: z.boolean().optional(),
  })
  .strict()
  .optional();
