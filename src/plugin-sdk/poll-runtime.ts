/**
 * Runtime SDK subpath for poll input normalization and selection limits.
 */
export type { PollInput } from "../polls.js";
export { normalizePollInput } from "../polls.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { resolvePollMaxSelections } from "../polls.js";
