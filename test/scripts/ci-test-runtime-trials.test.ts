import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { glob } from "tinyglobby";
import { afterEach, expect, it, vi } from "vitest";
import { runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  ciTestShardRequiresBun as requiresBun,
  resolveCiTestRuntimePolicy as runtimePolicy,
  resolveCiTestRuntimeSelections as selections,
} from "../../scripts/lib/ci-test-runtime.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const processConfig = "test/vitest/vitest.process.config.ts";
const nodeFile = "src/process/spawn-broker/cleanup.test.ts";
const bunFile = "src/process/spawn-broker/context.test.ts";

function group(name: string, config: string, includePatterns?: string[]) {
  return { kind: "group" as const, name, plan: { configs: [config], includePatterns } };
}
async function recordRun(
  plan: Parameters<typeof runShardPlans>[0][number],
  baseEnv: NodeJS.ProcessEnv,
  scratchDir = tempDirs.make("runtime-"),
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
    env: baseEnv,
    scratchDir,
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

const nodeOnlyFile = "src/infra/exec-host.socket.test.ts";

it.each([
  nodeOnlyFile,
  "src/gateway/artifact-downloads.test.ts",
  "test/talk-browser-defaults.test.ts",
  "test/scripts/control-ui-cold-load-trace.test.ts",
  "src/infra/tailscale-route-owner.worker.test.ts",
  "src/state/openclaw-database-preflight.startup-prepared.test.ts",
  "src/state/openclaw-state-ownership.test.ts",
  "src/gateway/session-utils.fs.display-position.test.ts",
  "extensions/team-reports/src/render/theme.test.ts",
  "src/infra/owned-directory-observation.test.ts",
  "test/helpers/openclaw-test-instance.test.ts",
])("selects the required engines for %s", (file) => {
  for (const policy of ["bun-all", "dual-all"] as const) {
    expect(selections({ targets: [file] }, policy)).toEqual(
      file === nodeOnlyFile
        ? [{ runtime: "node" }]
        : [...(policy === "dual-all" ? [{ runtime: "node" }] : []), { runtime: "bun" }],
    );
  }
});

it.each([
  ["full-agentic", ["src/gateway/server-methods/diagnostics.heap-snapshot.test.ts"]],
  ["gateway-core", []],
  ["gateway-methods", ["src/gateway/server-methods/diagnostics.heap-snapshot.test.ts"]],
  ["gateway-client", []],
] as const)("preserves Gateway Node contracts for the %s inventory", async (name, files) => {
  for (const policy of ["bun-all", "dual-all"] as const) {
    const { calls } = await recordRun(group(name, `test/vitest/vitest.${name}.config.ts`), {
      OPENCLAW_CI_TEST_RUNTIME_POLICY: policy,
    });
    const expected = files.map((file) => path.resolve(file)).toSorted();
    const gatewayRoot = `${path.resolve("src/gateway")}${path.sep}`;
    const nodeCall = calls.find(({ runtime }) => runtime === "node");
    if (policy === "bun-all") {
      expect(nodeCall?.args.filter((arg) => arg.startsWith(gatewayRoot)).toSorted() ?? []).toEqual(
        expected,
      );
    } else {
      expect(nodeCall).toBeDefined();
    }
    expect(
      calls
        .find(({ runtime }) => runtime === "bun")!
        .args.filter((arg) => arg.startsWith(`--exclude=${gatewayRoot}`))
        .map((arg) => arg.slice("--exclude=".length))
        .toSorted(),
    ).toEqual(expected);
  }
});

it.each(["node", "bun-all", "dual-all"] as const)(
  "accepts %s without changing the default",
  (policy) => {
    expect(runtimePolicy({ OPENCLAW_CI_TEST_RUNTIME_POLICY: policy })).toBe(policy);
    expect(runtimePolicy({})).toBe("node");
    expect(() => runtimePolicy({ OPENCLAW_CI_TEST_RUNTIME_POLICY: "all" })).toThrow(
      "Invalid OPENCLAW_CI_TEST_RUNTIME_POLICY",
    );
  },
);

it.each(["bun-all", "dual-all"] as const)(
  "runs unqualified configs and unusual arguments on Bun under %s",
  (policy) => {
    const selection = {
      configs: ["unknown.config.ts"],
      includePatterns: ["extensions/future/**/*.test.ts"],
      vitestArgs: ["--retry=1", "--testNamePattern=works"],
    };
    expect(selections(selection, policy)).toEqual([
      ...(policy === "dual-all" ? [{ runtime: "node" }] : []),
      { runtime: "bun" },
    ]);
    expect(requiresBun(selection, policy)).toBe(true);
  },
);

it.each(["bun-all", "dual-all"] as const)(
  "partitions process discovery and retains failures under %s",
  async (policy) => {
    const { calls, exitCode } = await recordRun(
      group("process", processConfig, [nodeFile, bunFile]),
      { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
      undefined,
      true,
    );
    expect(exitCode).toBe(1);
    const discovered = await Promise.all(
      calls.map(async ({ args, includes, runtime }) => {
        const ignore = args
          .filter((arg) => arg.startsWith("--exclude="))
          .map((arg) => arg.slice("--exclude=".length));
        const files = await glob(
          includes!.map((file) => path.relative("src", file)),
          { cwd: "src", ignore },
        );
        const filters = args.filter((arg) => path.isAbsolute(arg));
        return {
          runtime,
          files: files
            .filter((file) => !filters.length || filters.includes(path.resolve("src", file)))
            .map((file) => `src/${file}`)
            .toSorted(),
        };
      }),
    );
    expect(discovered).toEqual([
      {
        runtime: "node",
        files: policy === "dual-all" ? [nodeFile, bunFile].toSorted() : [nodeFile],
      },
      { runtime: "bun", files: [bunFile] },
    ]);
  },
);

it("preserves include files and Node exceptions for unknown configs", async () => {
  const scratch = tempDirs.make("all-includes-");
  const includeFile = path.join(scratch, "includes.json");
  writeFileSync(includeFile, JSON.stringify([path.resolve(nodeFile), path.resolve(bunFile)]));
  const { calls } = await recordRun(
    group("unknown", "unknown.config.ts"),
    {
      OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-all",
      OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
      OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--retry=2", "--", "context"]),
    },
    scratch,
  );
  expect(calls.map(({ runtime, includes }) => ({ runtime, includes }))).toEqual([
    { runtime: "node", includes: [path.resolve(nodeFile), path.resolve(bunFile)] },
    { runtime: "bun", includes: [path.resolve(nodeFile), path.resolve(bunFile)] },
  ]);
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
  expect(selected).toHaveLength(2);
  expect(selected[0]!.runtime).toBe("node");
  expect(selected[0]!.vitestArgs).toContain(path.resolve(nodeFile));
  expect(selected[1]!.runtime).toBe("bun");
  expect(selected[1]!.vitestArgs).toContain(`--exclude=${path.resolve(nodeFile)}`);
  expect(requiresBun(selection, "bun-all")).toBe(true);
});

it("retains exact Node exceptions and selects broad target remainders on Bun", async () => {
  for (const target of [nodeFile, `./${nodeFile}`, path.resolve(nodeFile)]) {
    expect(selections({ targets: [target] }, "bun-all")).toEqual([{ runtime: "node" }]);
  }
  const { calls } = await recordRun(
    { kind: "target", name: "process", target: "src/process" },
    { OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-all" },
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]!.runtime).toBe("node");
  expect(calls[0]!.args).toContain(nodeFile);
  expect(calls[0]!.args).not.toContain("src/process");
  expect(calls[1]!.runtime).toBe("bun");
  expect(calls[1]!.args).toContain("src/process");
  expect(calls[1]!.args).toContain(`--exclude=${path.resolve(nodeFile)}`);
});

it.each(["patterns", "include-file", "post-shard-file"])(
  "preserves UI discovery and native shard membership through %s",
  async (source) => {
    const uiNode = "ui/src/pages/chat/chat-thread-retention.test.ts";
    const uiBun = "ui/src/pages/chat/chat-pane-history.test.ts";
    const scratch = tempDirs.make("all-ui-");
    const includeFile = path.join(scratch, "includes.json");
    writeFileSync(includeFile, JSON.stringify([uiNode, uiBun]));
    const { calls } = await recordRun(
      group("ui", "ui/vitest.config.ts", source === "patterns" ? [uiNode, uiBun] : undefined),
      {
        OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-all",
        OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--shard=1/2"]),
        ...(source !== "patterns" ? { OPENCLAW_VITEST_INCLUDE_FILE: includeFile } : {}),
        ...(source === "post-shard-file"
          ? { OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: includeFile }
          : {}),
      },
      scratch,
    );
    expect(calls.map(({ runtime, includes }) => ({ runtime, includes }))).toEqual([
      { runtime: "node", includes: [uiNode, uiBun] },
      { runtime: "bun", includes: [uiNode, uiBun] },
    ]);
    expect(calls[0]!.members).toEqual([uiNode]);
    expect(calls[1]!.members).toContain(uiBun);
    expect(calls[1]!.members).not.toContain(uiNode);
  },
);
