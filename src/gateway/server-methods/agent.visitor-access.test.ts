// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  resetAgentTaskRegistryForTests,
  restoreAgentTaskRegistryRuntimeAfterTests,
} from "./agent.test-harness.js";
import { afterAll } from "vitest";
import "./agent.visitor-access.test-utils.js";

resetAgentTaskRegistryForTests();
afterAll(restoreAgentTaskRegistryRuntimeAfterTests);
