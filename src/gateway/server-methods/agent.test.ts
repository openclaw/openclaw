import { afterAll } from "vitest";
import {
  resetAgentTaskRegistryForTests,
  restoreAgentTaskRegistryRuntimeAfterTests,
} from "./agent.test-harness.js";
import "./agent.base.test-utils.js";
import "./agent.media-and-routing.test-utils.js";
import "./agent.events-and-subagents.test-utils.js";
import "./agent.sessions-and-models.test-utils.js";
import "./agent.cancellation.test-utils.js";
import "./agent.session-followup.test-utils.js";
import "./agent.reset-and-identity.test-utils.js";
import "./agent.abort-integration.test-utils.js";
import "./agent.caller-authority.test-utils.js";
import "./agent.dispatch-clock.test-utils.js";

resetAgentTaskRegistryForTests();
afterAll(restoreAgentTaskRegistryRuntimeAfterTests);
