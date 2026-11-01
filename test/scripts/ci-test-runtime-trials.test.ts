import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { glob } from "tinyglobby";
import { afterEach, expect, it, vi } from "vitest";
import { runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  ciTestShardRequiresBun as requiresBun,
  resolveCiTestRuntimeSelections as selections,
} from "../../scripts/lib/ci-test-runtime.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const processConfig = "test/vitest/vitest.process.config.ts";
const agentsConfig = "test/vitest/vitest.agents-core.config.ts";
const infraConfig = "test/vitest/vitest.infra.config.ts";
const supportConfig = "test/vitest/vitest.unit-support.config.ts";
const nodeFile = "src/process/spawn-broker/cleanup.test.ts";
const bunFile = "src/process/spawn-broker/context.test.ts";
const validatorFile = "src/agents/agent-tools.execution-validation.test.ts";
const agentBunFile = "src/agents/agent-tools.policy.test.ts";
const websocketFile = "packages/ai/src/transports/openai-responses-websocket.test.ts";
const websocketBunFiles = [
  "packages/ai/src/transports/openai-responses-websocket-client.test.ts",
  "packages/ai/src/transports/openai-responses-runtime-cleanup.integration.test.ts",
];
const codeModeFiles = [
  "src/agents/code-mode.bridge.lifecycle.test.ts",
  "src/agents/code-mode-engine-parity.test.ts",
  "src/agents/code-mode.failure-phase.test.ts",
];
// Gateway-core files precede database-worker files for the focused owner assertion.
const sessionWeakRefFiles = [
  "src/gateway/session-list-history-retention.test.ts",
  "src/gateway/session-row-projection.retention.test.ts",
  "src/gateway/session-database-retention.test.ts",
];
const uiRetentionFiles = [
  "ui/src/components/desktop/desktop-mobile-keyboard-retention.test.ts",
  "ui/src/pages/chat/components/chat-transcript-layout-retention.test.ts",
  "ui/src/pages/chat/session-snapshot-store-retention.test.ts",
];
const uiFunctionalFiles = [
  "ui/src/components/desktop/desktop-mobile-keyboard.test.ts",
  "ui/src/pages/chat/components/chat-transcript-layout-owner.test.ts",
  "ui/src/pages/chat/session-snapshot-store.test.ts",
];

function group(name: string, config: string | readonly string[], includePatterns?: string[]) {
  const configs = typeof config === "string" ? [config] : [...config];
  return { kind: "group" as const, name, plan: { configs, includePatterns } };
}
async function recordRun(
  plan: Parameters<typeof runShardPlans>[0][number],
  baseEnv: NodeJS.ProcessEnv = {},
  failNode = false,
) {
  const calls: Array<{
    runtime: string | undefined;
    args: string[];
    includes?: string[];
    members?: string[];
  }> = [];
  const readList = (file: string | undefined): string[] | undefined =>
    file ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  const exitCode = await runShardPlans([plan], {
    env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-all", ...baseEnv },
    scratchDir: tempDirs.make("runtime-"),
    runChild: async (args, env) => {
      calls.push({
        runtime: env.OPENCLAW_VITEST_RUNTIME,
        args,
        includes: readList(env.OPENCLAW_VITEST_INCLUDE_FILE),
        members: readList(env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE),
      });
      return failNode && env.OPENCLAW_VITEST_RUNTIME === "node" ? 1 : 0;
    },
  });
  return { calls, exitCode };
}

function expectIncludes(calls: Awaited<ReturnType<typeof recordRun>>["calls"], expected: string[]) {
  const actual = calls.map(({ runtime, includes }) => ({ runtime, includes }));
  expect(actual).toEqual(["node", "bun"].map((runtime) => ({ runtime, includes: expected })));
}

async function discoverRun(calls: Awaited<ReturnType<typeof recordRun>>["calls"]) {
  return Promise.all(
    calls.map(async ({ args, includes, runtime }) => {
      const ignore = args
        .filter((arg) => arg.startsWith("--exclude="))
        .map((arg) => arg.slice("--exclude=".length));
      const files = await glob(includes!, { cwd: process.cwd(), ignore });
      const filters = args.filter((arg) => path.isAbsolute(arg));
      return {
        runtime,
        files: files
          .filter((file) => !filters.length || filters.includes(path.resolve(file)))
          .toSorted(),
      };
    }),
  );
}

it.each([
  [nodeFile, false],
  [validatorFile, false],
  [websocketFile, false],
  ...uiRetentionFiles.map((file) => [file, false] as const),
  ...codeModeFiles.map((file) => [file, true] as const),
] as const)("retains host coverage for exact target %s", async (file, bothHosts) => {
  for (const target of [file, `./${file}`, path.resolve(file)]) {
    for (const policy of ["node", "bun-all", "dual-all"] as const) {
      if (!bothHosts) {
        expect(selections({ targets: [target] }, policy)).toEqual([{ runtime: "node" }]);
      }
      const runtimes = bothHosts && policy !== "node" ? ["node", "bun"] : ["node"];
      const { calls } = await recordRun(
        { kind: "target", name: "exact", target },
        { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
      );
      expect(
        calls.map(({ runtime, args }) => ({
          runtime,
          files: args.map((arg) => path.resolve(arg)),
        })),
      ).toEqual(runtimes.map((runtime) => ({ runtime, files: [path.resolve(file)] })));
      expect(requiresBun({ targets: [target] }, policy)).toBe(runtimes.includes("bun"));
    }
  }
});

it.each([
  [
    "full-agentic",
    "src/gateway",
    ["src/gateway/server-methods/diagnostics.heap-snapshot.test.ts", ...sessionWeakRefFiles],
    [],
  ],
  ["gateway-core", "src/gateway", sessionWeakRefFiles.slice(0, 2), []],
  ["gateway-database-workers", "src/gateway", sessionWeakRefFiles.slice(2), []],
  [
    "gateway-methods",
    "src/gateway",
    ["src/gateway/server-methods/diagnostics.heap-snapshot.test.ts"],
    [],
  ],
  ["agents-core", "src/agents", [validatorFile], codeModeFiles.slice(1)],
  ["infra", "src/agents", [], codeModeFiles.slice(0, 1)],
  ["unit-support", "packages", [websocketFile], []],
] as const)(
  "preserves Node contracts for the %s inventory",
  async (name, root, files, bothHosts) => {
    const plan = group(name, `test/vitest/vitest.${name}.config.ts`);
    const expected = files.map((file) => path.resolve(file)).toSorted();
    const expectedNode = [...files, ...bothHosts].map((file) => path.resolve(file)).toSorted();
    const ownerRoot = `${path.resolve(root)}${path.sep}`;
    for (const policy of ["node", "bun-all", "dual-all"] as const) {
      const { calls } = await recordRun(plan, { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy });
      expect(requiresBun(plan.plan, policy)).toBe(policy !== "node");
      expect(calls.map(({ runtime }) => runtime)).toEqual(
        policy === "node" ? ["node"] : ["node", "bun"],
      );
      const nodeArgs = calls.find(({ runtime }) => runtime === "node")?.args ?? [];
      const bunArgs = calls.find(({ runtime }) => runtime === "bun")?.args ?? [];
      expect(nodeArgs.filter((arg) => arg.startsWith(ownerRoot)).toSorted()).toEqual(
        policy === "bun-all" ? expectedNode : [],
      );
      expect(
        bunArgs
          .filter((arg) => arg.startsWith(`--exclude=${ownerRoot}`))
          .map((arg) => arg.slice("--exclude=".length))
          .toSorted(),
      ).toEqual(policy === "node" ? [] : expected);
    }
  },
);

it.each(["bun-all", "dual-all"] as const)(
  "runs Bun only in sibling projects owning a remaining file under %s",
  async (policy) => {
    const heapFile = "src/gateway/server-methods/diagnostics.heap-snapshot.test.ts";
    const isolatedConfig = "test/vitest/vitest.gateway-methods-isolated.config.ts";
    const configs = ["test/vitest/vitest.gateway-methods.config.ts", isolatedConfig];
    const includePatterns = [
      heapFile,
      "src/gateway/server-methods/sessions.send-yield-resume.test.ts",
    ];
    const { calls } = await recordRun(
      { kind: "group", name: "gateway-methods", plan: { configs, includePatterns } },
      { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
    );
    expectIncludes(calls, includePatterns);
    expect(calls[0]!.args.slice(0, 2)).toEqual(configs);
    // The methods project excludes its isolated sibling, leaving no Bun file.
    expect(calls[1]!.args).toEqual([isolatedConfig, "--", `--exclude=${path.resolve(heapFile)}`]);
  },
);

it.each(["node", "bun-all", "dual-all"] as const)(
  "partitions discovery and retains failures under %s",
  async (policy) => {
    for (const [configs, nodeOnly, bunOnly, bothHosts] of [
      [[processConfig], [nodeFile], [bunFile], []],
      [[agentsConfig], [validatorFile], [agentBunFile], []],
      [[supportConfig], [websocketFile], websocketBunFiles, []],
      [
        [processConfig, infraConfig, agentsConfig],
        [nodeFile],
        [bunFile, "src/agents/code-mode-node.lifecycle.test.ts"],
        codeModeFiles,
      ],
    ] as const) {
      const includePatterns = [...nodeOnly, ...bunOnly, ...bothHosts];
      const { calls, exitCode } = await recordRun(
        group("mixed", configs, includePatterns),
        { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
        true,
      );
      expect(exitCode).toBe(1);
      for (const { args } of calls) {
        expect(args).toEqual(expect.arrayContaining([...configs]));
      }
      expect(await discoverRun(calls)).toEqual([
        {
          runtime: "node",
          files: (policy === "bun-all" ? [...nodeOnly, ...bothHosts] : includePatterns).toSorted(),
        },
        ...(policy === "node"
          ? []
          : [{ runtime: "bun", files: [...bunOnly, ...bothHosts].toSorted() }]),
      ]);
    }
  },
);

it("preserves include files and Node exceptions for unknown configs", async () => {
  const scratch = tempDirs.make("all-includes-");
  const includeFile = path.join(scratch, "includes.json");
  writeFileSync(includeFile, JSON.stringify([path.resolve(nodeFile), path.resolve(bunFile)]));
  const { calls } = await recordRun(group("unknown", "unknown.config.ts"), {
    OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
    OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--retry=2", "--", "context"]),
  });
  expectIncludes(calls, [path.resolve(nodeFile), path.resolve(bunFile)]);
  expect(calls[1]!.args).toEqual([
    "unknown.config.ts",
    "--",
    `--exclude=${path.resolve(nodeFile)}`,
    "--retry=2",
    "--",
    "context",
  ]);
});

it("retains Node exceptions when argv overrides a known config", () => {
  const selection = {
    configs: ["test/vitest/vitest.extension-memory.config.ts"],
    vitestArgs: ["--config", processConfig],
  };
  const selected = selections(selection, "bun-all");
  expect(selected.map(({ runtime }) => runtime)).toEqual(["node", "bun"]);
  expect(selected[0]!.vitestArgs).toContain(path.resolve(nodeFile));
  expect(selected[1]!.vitestArgs).toContain(`--exclude=${path.resolve(nodeFile)}`);
  expect(requiresBun(selection, "bun-all")).toBe(true);
});

it("selects broad target remainders on Bun", async () => {
  for (const [target, runtime] of [
    [agentBunFile, "bun"],
    ...websocketBunFiles.map((file) => [file, "bun"] as const),
    ...uiFunctionalFiles.map((file) => [file, "bun"] as const),
    ["src/config/sessions/session-accessor.pending-input-retention.test.ts", "node"],
    ["src/config/sessions/session-accessor.pending-inputs.test.ts", "bun"],
    ["src/gateway/session-row-projection.accepted-facts.test.ts", "bun"],
    ["src/gateway/session-sharing-preparation.test.ts", "bun"],
  ] as const) {
    expect(selections({ targets: [target] }, "bun-all")).toEqual([{ runtime }]);
  }
  const { calls } = await recordRun({ kind: "target", name: "process", target: "src/process" });
  expect(calls.map(({ runtime }) => runtime)).toEqual(["node", "bun"]);
  expect(calls[0]!.args).toContain(nodeFile);
  expect(calls[0]!.args).not.toContain("src/process");
  expect(calls[1]!.args).toContain("src/process");
  expect(calls[1]!.args).toContain(`--exclude=${path.resolve(nodeFile)}`);
});

it.each(["patterns", "include-file", "post-shard-file"])(
  "preserves UI discovery and native shard membership through %s",
  async (source) => {
    const uiFiles = [...uiRetentionFiles, ...uiFunctionalFiles];
    const scratch = tempDirs.make("all-ui-");
    const includeFile = path.join(scratch, "includes.json");
    writeFileSync(includeFile, JSON.stringify(uiFiles));
    const { calls } = await recordRun(
      group("ui", "ui/vitest.config.ts", source === "patterns" ? uiFiles : undefined),
      {
        OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--shard=1/2"]),
        ...(source !== "patterns" ? { OPENCLAW_VITEST_INCLUDE_FILE: includeFile } : {}),
        ...(source === "post-shard-file"
          ? { OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: includeFile }
          : {}),
      },
    );
    expectIncludes(calls, uiFiles);
    expect(calls[0]!.members?.toSorted()).toEqual(uiRetentionFiles.toSorted());
    expect(
      calls[1]!.includes!.filter((file) => calls[1]!.members?.includes(file)).toSorted(),
    ).toEqual(uiFunctionalFiles.toSorted());
  },
);
