/**
 * Public SDK type barrel for plugin hook contracts.
 *
 * This barrel intentionally tracks public hook contract type changes so the
 * extension package-boundary cache invalidates when hook payload shapes change.
 */
export type * from "../plugins/hook-types.js";
