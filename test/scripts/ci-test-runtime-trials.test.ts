import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { glob } from "tinyglobby";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  ciTestShardRequiresBun,
  resolveCiTestRuntimePolicy,
  resolveCiTestRuntimeSelections,
} from "../../scripts/lib/ci-test-runtime.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const processConfig = "test/vitest/vitest.process.config.ts";
const nodeFile = "src/process/spawn-broker/cleanup.test.ts";
const bunFile = "src/process/spawn-broker/context.test.ts";

describe("explicit all-test runtime trials", () => {
  it.each([
    "src/infra/owned-directory-observation.test.ts",
    "src/infra/tailscale-route-owner.worker.test.ts",
    "src/gateway/session-utils.fs.display-position.test.ts",
    "src/infra/exec-host.socket.test.ts",
    "src/state/openclaw-database-preflight.startup-prepared.test.ts",
    "src/state/openclaw-state-ownership.test.ts",
  ])("keeps the blocked native contract in %s on Node", (file) => {
    for (const policy of ["bun-all", "dual-all"] as const) {
      expect(resolveCiTestRuntimeSelections({ targets: [file] }, policy)).toEqual([
        { runtime: "node" },
      ]);
    }
  });

  it.each(["bun-all", "dual-all"] as const)(
    "runs the test-instance cleanup contract on Bun under %s",
    (policy) => {
      expect(
        resolveCiTestRuntimeSelections(
          { targets: ["test/helpers/openclaw-test-instance.test.ts"] },
          policy,
        ),
      ).toEqual([...(policy === "dual-all" ? [{ runtime: "node" }] : []), { runtime: "bun" }]);
    },
  );

  it.each(["node", "bun-compatible", "dual", "bun-all", "dual-all"] as const)(
    "accepts %s without changing the default",
    (policy) => {
      expect(resolveCiTestRuntimePolicy({ OPENCLAW_CI_TEST_RUNTIME_POLICY: policy })).toBe(policy);
      expect(resolveCiTestRuntimePolicy({})).toBe("node");
      expect(() => resolveCiTestRuntimePolicy({ OPENCLAW_CI_TEST_RUNTIME_POLICY: "all" })).toThrow(
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
      expect(resolveCiTestRuntimeSelections(selection, policy)).toEqual([
        ...(policy === "dual-all" ? [{ runtime: "node" }] : []),
        { runtime: "bun" },
      ]);
      expect(ciTestShardRequiresBun(selection, policy)).toBe(true);
      expect(resolveCiTestRuntimeSelections(selection, "bun-compatible")).toEqual([
        { runtime: "node" },
      ]);
    },
  );

  it.each(["bun-all", "dual-all"] as const)(
    "keeps named process contracts on Node and runs the full remaining selection on Bun under %s",
    async (policy) => {
      const calls: Array<{ runtime: string | undefined; files: string[] }> = [];
      await expect(
        runShardPlans(
          [
            {
              kind: "group",
              name: "process",
              plan: { configs: [processConfig], includePatterns: [nodeFile, bunFile] },
            },
          ],
          {
            env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
            scratchDir: tempDirs.make("all-runtime-"),
            runChild: async (args, env) => {
              const includes: string[] = JSON.parse(
                readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8"),
              );
              const excluded = args
                .filter((arg) => arg.startsWith("--exclude="))
                .map((arg) => arg.slice("--exclude=".length));
              // Exercise Vitest's actual discovery library with a scoped working directory.
              const discovered = await glob(
                includes.map((file) => path.relative("src", file)),
                { cwd: "src", ignore: excluded },
              );
              const fileFilters = args.filter((arg) => path.isAbsolute(arg));
              const files = discovered.filter(
                (file) => !fileFilters.length || fileFilters.includes(path.resolve("src", file)),
              );
              calls.push({
                runtime: env.OPENCLAW_VITEST_RUNTIME,
                files: files.map((file) => `src/${file}`).toSorted(),
              });
              return env.OPENCLAW_VITEST_RUNTIME === "node" ? 1 : 0;
            },
          },
        ),
      ).resolves.toBe(1);
      expect(calls).toEqual([
        {
          runtime: "node",
          files: policy === "dual-all" ? [nodeFile, bunFile].toSorted() : [nodeFile],
        },
        { runtime: "bun", files: [bunFile] },
      ]);
    },
  );

  it("preserves include-file selection for unknown configs and does not bypass named exceptions", async () => {
    const scratch = tempDirs.make("all-includes-");
    const includeFile = path.join(scratch, "includes.json");
    writeFileSync(includeFile, JSON.stringify([path.resolve(nodeFile), path.resolve(bunFile)]));
    const calls: Array<{ runtime: string | undefined; includes: string[]; args: string[] }> = [];
    await runShardPlans(
      [{ kind: "group", name: "unknown", plan: { configs: ["unknown.config.ts"] } }],
      {
        env: {
          OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-all",
          OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
          OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--retry=2", "--", "context"]),
        },
        scratchDir: scratch,
        runChild: async (args, env) => {
          calls.push({
            runtime: env.OPENCLAW_VITEST_RUNTIME,
            includes: JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8")),
            args,
          });
          return 0;
        },
      },
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
    const selected = resolveCiTestRuntimeSelections(selection, "bun-all");
    expect(selected).toHaveLength(2);
    expect(selected[0]!.runtime).toBe("node");
    expect(selected[0]!.vitestArgs).toContain(path.resolve(nodeFile));
    expect(selected[1]!.runtime).toBe("bun");
    expect(selected[1]!.vitestArgs).toContain(`--exclude=${path.resolve(nodeFile)}`);
    expect(ciTestShardRequiresBun(selection, "bun-all")).toBe(true);
  });

  it("retains exact Node exceptions and selects broad target remainders on Bun", async () => {
    for (const target of [
      nodeFile,
      `./${nodeFile}`,
      path.resolve(nodeFile),
      "test/scripts/control-ui-cold-load-trace.test.ts",
      "test/talk-browser-defaults.test.ts",
      "src/gateway/artifact-downloads.test.ts",
    ]) {
      expect(resolveCiTestRuntimeSelections({ targets: [target] }, "bun-all")).toEqual([
        { runtime: "node" },
      ]);
    }
    const calls: Array<{ runtime: string | undefined; args: string[] }> = [];
    await runShardPlans([{ kind: "target", name: "process", target: "src/process" }], {
      env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-all" },
      scratchDir: tempDirs.make("all-targets-"),
      runChild: async (args, env) => {
        calls.push({ runtime: env.OPENCLAW_VITEST_RUNTIME, args });
        return 0;
      },
    });
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
      const calls: Array<{ runtime: string | undefined; includes: string[]; members: string[] }> =
        [];
      const scratch = tempDirs.make("all-ui-");
      const includeFile = path.join(scratch, "includes.json");
      writeFileSync(includeFile, JSON.stringify([uiNode, uiBun]));
      await runShardPlans(
        [
          {
            kind: "group",
            name: "ui",
            plan: {
              configs: ["ui/vitest.config.ts"],
              ...(source === "patterns" ? { includePatterns: [uiNode, uiBun] } : {}),
            },
          },
        ],
        {
          env: {
            OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-all",
            OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--shard=1/2"]),
            ...(source !== "patterns" ? { OPENCLAW_VITEST_INCLUDE_FILE: includeFile } : {}),
            ...(source === "post-shard-file"
              ? { OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: includeFile }
              : {}),
          },
          scratchDir: scratch,
          runChild: async (_args, env) => {
            calls.push({
              runtime: env.OPENCLAW_VITEST_RUNTIME,
              includes: JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8")),
              members: JSON.parse(
                readFileSync(env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE!, "utf8"),
              ),
            });
            return 0;
          },
        },
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
});
