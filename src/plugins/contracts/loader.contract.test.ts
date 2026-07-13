// Loader contract tests cover plugin loader behavior, registry setup, and reset boundaries.
import { expect } from "vitest";

const ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_IDS = ["codex", "qa-lab"] as const;
const ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_ID_SET = new Set<string>(
  ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_IDS,
);

function expectPluginAllowlistEquals(
  allow: string[] | undefined,
  pluginIds: string[],
  expectedExtraEntry?: string,
) {
  expect(allow).toEqual(expectedExtraEntry ? [expectedExtraEntry, ...pluginIds] : pluginIds);
}
