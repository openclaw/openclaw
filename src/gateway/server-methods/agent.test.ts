// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  resetAgentTaskRegistryForTests,
  restoreAgentTaskRegistryRuntimeAfterTests,
} from "./agent.test-harness.js";
import { afterAll, beforeAll } from "vitest";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import "./agent.base.test-utils.js";
import "./agent.media-and-routing.test-utils.js";
import "./agent.events-and-subagents.test-utils.js";
import "./agent.sessions-and-models.test-utils.js";
import "./agent.expected-session.test-utils.js";
import "./agent.cancellation.test-utils.js";
import "./agent.session-followup.test-utils.js";
import "./agent.reset-and-identity.test-utils.js";
import "./agent.abort-integration.test-utils.js";
import "./agent.caller-authority.test-utils.js";
import "./agent.dispatch-clock.test-utils.js";

resetAgentTaskRegistryForTests();
beforeAll(() => {
  // Handler cases share the real startup inventory; no case changes plugin
  // installation, so admission can consume prepared metadata like a live Gateway.
  setGatewayPluginMetadataSnapshot(
    loadPluginMetadataSnapshot({ config: {}, allowCurrent: false }),
    { config: {} },
  );
});
afterAll(() => {
  restoreAgentTaskRegistryRuntimeAfterTests();
  clearCurrentPluginMetadataSnapshot();
});
