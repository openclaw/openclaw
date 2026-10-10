import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildChildEnv, resolveShardChildCommand } from "../../scripts/ci-run-node-test-shard.mts";
import { resolveCiTestRuntimeSelections } from "../../scripts/lib/ci-test-runtime.mts";
import { createVitestRunSpecs } from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createAgentsSupportVitestConfig } from "../vitest/vitest.agents-support.config.js";
import { createGatewayMethodsVitestConfig } from "../vitest/vitest.gateway-methods.config.js";
import { matchesVitestGlob } from "../vitest/vitest.pattern-file.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const support = "test/vitest/vitest.agents-support.config.ts";
const gateway = "test/vitest/vitest.gateway-methods.config.ts";
const nested = "src/agents/harness/gateway-question.authority-worker.test.ts";
const fast = "src/agents/harness/execution-environment.test.ts";
const foreign = "src/agents/shell-snapshot.broker.test.ts";
const doctor = "src/commands/doctor-sqlite-nocow.test.ts";
const snapshot = "src/gateway/server-methods/diagnostics.heap-snapshot.test.ts";
const plugin = "test/plugins/team-reports-http.gateway.test.ts";
const isolated = "src/gateway/server-methods/transcripts.test.ts";
const witnesses = [nested, fast, foreign, doctor, snapshot, plugin, isolated];

const supportCases = [
  { name: "full owner", includes: undefined, runtime: "bun", files: [nested] },
  { name: "empty override", includes: [], runtime: "bun", files: [nested] },
  {
    name: "repository owner pattern",
    includes: ["src/agents/*/**/*.test.ts"],
    runtime: "bun",
    files: [nested],
  },
  { name: "scoped owner pattern", includes: ["*/**/*.test.ts"], runtime: "bun", files: [nested] },
  { name: "repository file", includes: [nested], runtime: "bun", files: [nested] },
  { name: "nested unit-fast file", includes: [fast], runtime: "node", files: [] },
  { name: "mixed with unit-fast", includes: [nested, fast], runtime: "node", files: [nested] },
  {
    name: "scoped file",
    includes: ["harness/gateway-question.authority-worker.test.ts"],
    runtime: "bun",
    files: [nested],
  },
  { name: "broad glob", includes: ["**/*.test.ts"], runtime: "node", files: [nested, foreign] },
  {
    name: "uncertain nested glob",
    includes: ["harness/**/*.test.ts"],
    runtime: "node",
    files: [nested],
  },
  { name: "top-level foreign file", includes: [foreign], runtime: "node", files: [foreign] },
  { name: "mixed owners", includes: [nested, foreign], runtime: "node", files: [nested, foreign] },
  {
    name: "foreign traversal",
    includes: ["../commands/doctor-sqlite-nocow.test.ts"],
    runtime: "node",
    files: [doctor],
  },
  {
    name: "absolute foreign file",
    includes: [path.resolve(foreign)],
    runtime: "node",
    files: [foreign],
  },
] as const;

const gatewayCases = [
  { name: "full owner", includes: undefined, runtime: "bun", files: [snapshot, plugin] },
  { name: "empty override", includes: [], runtime: "bun", files: [snapshot, plugin] },
  {
    name: "canonical methods pattern",
    includes: ["src/gateway/server-methods/**/*.test.ts"],
    runtime: "bun",
    files: [snapshot],
  },
  { name: "canonical plugin file", includes: [plugin], runtime: "bun", files: [plugin] },
  { name: "repository file", includes: [snapshot], runtime: "bun", files: [snapshot] },
  { name: "scoped root file", includes: [`./${snapshot}`], runtime: "bun", files: [snapshot] },
  { name: "broad glob", includes: ["**/*.test.ts"], runtime: "node", files: [snapshot, plugin] },
  { name: "foreign owner file", includes: [nested], runtime: "node", files: [] },
  { name: "mixed owners", includes: [snapshot, nested], runtime: "node", files: [snapshot] },
  { name: "isolated owner file", includes: [isolated], runtime: "node", files: [] },
  {
    name: "absolute foreign file",
    includes: [path.resolve(foreign)],
    runtime: "node",
    error: "cannot safely intersect non-literal include path",
  },
  {
    name: "foreign traversal",
    includes: [`../${doctor}`],
    runtime: "node",
    error: "cannot safely intersect non-literal include path",
  },
] as const;

type OwnerScopeCase = (typeof supportCases)[number] | (typeof gatewayCases)[number];

describe.each([
  { config: support, cases: supportCases },
  { config: gateway, cases: gatewayCases },
])("$config", ({ config, cases }) => {
  it.each<OwnerScopeCase>(cases)("preserves selection through the child config: $name", (row) => {
    const scratch = tempDirs.make("openclaw-owner-scope-");
    const entry = {
      kind: "group" as const,
      name: "owner-scope",
      plan: { configs: [config], includePatterns: row.includes ? [...row.includes] : undefined },
    };
    for (const policy of ["node", "bun-compatible", "dual"] as const) {
      const selected = resolveCiTestRuntimeSelections(entry.plan, policy);
      const expected =
        policy === "node"
          ? ["node"]
          : policy === "dual" && row.runtime === "bun"
            ? ["node", "bun"]
            : [row.runtime];
      expect(selected).toEqual(expected.map((runtime) => ({ runtime })));
      for (const [index, selection] of selected.entries()) {
        const env = buildChildEnv(entry, {}, scratch, index, { runtime: selection.runtime });
        const child = resolveShardChildCommand(entry.plan.configs);
        const entrypoint = child.args.findIndex((arg) =>
          /^scripts\/test-projects\.m[tj]s$/u.test(arg),
        );
        expect(entrypoint).toBeGreaterThanOrEqual(0);
        const specs = createVitestRunSpecs(child.args.slice(entrypoint + 1), { baseEnv: env });
        expect(specs).toHaveLength(1);
        const spec = specs[0]!;
        expect(spec.includePatterns).toBeNull();
        if (row.includes?.length) {
          expect(JSON.parse(readFileSync(spec.env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8"))).toEqual(
            row.includes,
          );
        }
        const createConfig = () => {
          const previousArgv = process.argv;
          try {
            process.argv = [process.execPath, "vitest.mjs", "run", "--config", spec.config];
            return config === support
              ? createAgentsSupportVitestConfig(spec.env)
              : createGatewayMethodsVitestConfig(spec.env);
          } finally {
            process.argv = previousArgv;
          }
        };
        if ("error" in row) {
          expect(createConfig).toThrow(row.error);
          continue;
        }
        const test = createConfig().test!;
        const matches = (file: string, pattern: string) =>
          matchesVitestGlob(
            path.isAbsolute(pattern)
              ? path.resolve(file)
              : path.relative(test.dir!, path.resolve(file)).replaceAll("\\", "/"),
            pattern,
          );
        expect(
          witnesses.filter(
            (file) =>
              test.include!.some((pattern) => matches(file, pattern)) &&
              !test.exclude!.some((pattern) => matches(file, pattern)),
          ),
        ).toEqual(row.files);
      }
    }
  });
});
