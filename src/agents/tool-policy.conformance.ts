/**
 * Conformance snapshot for tool policy.
 *
 * Security note:
 * - This is static, build-time information (no runtime I/O, no network exposure).
 * - Intended for CI/tools to detect drift between the implementation policy and
 *   the formal models/extractors.
 */

import { TOOL_GROUPS } from "./tool-policy.js";

// Tool name aliases are intentionally not exported from tool-policy today.
// Keep the conformance snapshot focused on exported policy constants.

export const TOOL_POLICY_CONFORMANCE = {
  toolGroups: TOOL_GROUPS,
} as const;
