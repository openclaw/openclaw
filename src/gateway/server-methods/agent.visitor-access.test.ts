// The harness must install its mocks before the scenario imports production handlers.
import { afterAll } from "vitest";
import {
  resetAgentTaskRegistryForTests,
  restoreAgentTaskRegistryRuntimeAfterTests,
} from "./agent.test-harness.js";
import "./agent.visitor-access.test-utils.js";

resetAgentTaskRegistryForTests();
afterAll(restoreAgentTaskRegistryRuntimeAfterTests);
