import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
/**
 * Integration test: loads all test_routing.yaml files from agents/
 * and runs them against the real bundled agent manifests via routeTask().
 */
import { describe, test, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  routeTask,
  type AgentRegistryState,
  type RegisteredAgent,
} from "../gateway/agent-registry-service.js";
import { loadAgentFromDir } from "./agent-manifest-validation.js";
import { AgentTestSuiteSchema } from "./zod-schema.agent-test.js";

const AGENTS_DIR = join(import.meta.dirname, "..", "..", "agents");

/** Build a registry directly from bundled agents/ directory. */
async function buildBundledRegistry(): Promise<AgentRegistryState> {
  const agents: RegisteredAgent[] = [];
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const result = await loadAgentFromDir(join(AGENTS_DIR, entry.name));
    if (result.manifest) {
      agents.push({ manifest: result.manifest, scope: "project", status: "active" });
    }
  }
  return {
    agents,
    activeAgents: agents.filter((a) => a.status === "active"),
    disabledAgents: [],
    degraded: false,
  };
}

describe("Agent Routing YAML Tests (all agents)", async () => {
  const registry = await buildBundledRegistry();

  // Discover all test_routing.yaml files
  const agentDirs = await readdir(AGENTS_DIR, { withFileTypes: true });

  for (const entry of agentDirs.filter((e) => e.isDirectory())) {
    const testFile = join(AGENTS_DIR, entry.name, "tests", "test_routing.yaml");
    let content: string;
    try {
      content = await readFile(testFile, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseYaml(content);
    const result = AgentTestSuiteSchema.safeParse(parsed);
    if (!result.success) {
      test(`${entry.name}: invalid test file`, () => {
        expect.fail(`Invalid test_routing.yaml: ${result.error.issues[0]?.message}`);
      });
      continue;
    }

    describe(entry.name, () => {
      for (const tc of result.data.tests) {
        test(tc.name, () => {
          const routeResult = routeTask(tc.input, registry);

          if (tc.expect_route) {
            expect(
              routeResult.agent?.manifest.id,
              `expected route to "${tc.expect_route}" but got "${routeResult.agent?.manifest.id ?? "none"}" (scores: ${routeResult.scores.map((s) => `${s.agentId}=${s.score}`).join(", ")})`,
            ).toBe(tc.expect_route);
          }
          if (tc.expect_not_route) {
            expect(
              routeResult.agent?.manifest.id,
              `should not route to "${tc.expect_not_route}"`,
            ).not.toBe(tc.expect_not_route);
          }
          if (tc.expect_clarification !== undefined) {
            expect(routeResult.needsClarification).toBe(tc.expect_clarification);
          }
        });
      }
    });
  }
});
