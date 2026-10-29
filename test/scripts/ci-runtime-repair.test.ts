import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  ciTestShardRequiresBun,
  resolveCiTestRuntimeSelections,
} from "../../scripts/lib/ci-test-runtime.mts";
import pin from "../../scripts/lib/openclaw-bun.json" with { type: "json" };
import {
  resolveNativeBunTestCommand,
  resolveVitestTestCommand,
} from "../../scripts/lib/vitest-test-runtime.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nodeOnly = "src/process/spawn-broker/cleanup.test.ts";
const eligible = "src/process/spawn-broker/context.test.ts";

describe("beta.5 all-runtime repair contracts", () => {
  it.each([
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
  ])(
    "aggregates Node=%i and Bun=%i without losing either pass",
    async (nodeCode, bunCode, expected) => {
      const observed: string[] = [];
      const code = await runShardPlans(
        [{ kind: "group", name: "unknown", plan: { configs: ["unknown.config.ts"] } }],
        {
          env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual-all" },
          scratchDir: tempDirs.make("runtime-results-"),
          runChild: async (_args, env) => {
            observed.push(env.OPENCLAW_VITEST_RUNTIME!);
            return env.OPENCLAW_VITEST_RUNTIME === "node" ? nodeCode : bunCode;
          },
        },
      );
      expect(observed).toEqual(["node", "bun"]);
      expect(code).toBe(expected);
    },
  );

  it.each(["bun-all", "dual-all"] as const)(
    "matches provisioning to executable selection under %s",
    async (policy) => {
      for (const target of [nodeOnly, eligible]) {
        const observed: string[] = [];
        const shard = { targets: [target] };
        await runShardPlans([{ kind: "target", name: target, target }], {
          env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
          scratchDir: tempDirs.make("runtime-provision-"),
          runChild: async (_args, env) => {
            observed.push(env.OPENCLAW_VITEST_RUNTIME!);
            return 0;
          },
        });
        expect(ciTestShardRequiresBun(shard, policy)).toBe(observed.includes("bun"));
        expect(observed).toEqual(
          target === nodeOnly ? ["node"] : policy === "dual-all" ? ["node", "bun"] : ["bun"],
        );
      }
    },
  );

  it("preserves exact target argv and flags for both full passes", async () => {
    const observed: Array<{ runtime: string | undefined; args: string[] }> = [];
    const flags = ["--testNamePattern", "name with spaces", "--shard=2/3"];
    await runShardPlans([{ kind: "target", name: eligible, target: eligible }], {
      env: {
        OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual-all",
        OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(flags),
      },
      scratchDir: tempDirs.make("runtime-argv-"),
      runChild: async (args, env) => {
        observed.push({ runtime: env.OPENCLAW_VITEST_RUNTIME, args });
        return 0;
      },
    });
    expect(observed).toEqual([
      { runtime: "node", args: [eligible, "--", ...flags] },
      { runtime: "bun", args: [eligible, "--", ...flags] },
    ]);
  });

  it.each(["vitest", "native"] as const)(
    "executes the selected synthetic pinned %s binary with exact argv",
    (kind) => {
      // This proves the launch contract with an executable fixture, NOT real Bun qualification.
      const binary = path.join(tempDirs.make("synthetic-pinned-launch-"), "bun");
      const source = [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        'if (args[0] === "--revision") console.log(' + JSON.stringify(pin.revision) + ");",
        "else console.log(JSON.stringify(args));",
      ].join(String.fromCharCode(10));
      writeFileSync(binary, source);
      chmodSync(binary, 0o755);
      const env = {
        ...process.env,
        CI: "1",
        OPENCLAW_BUN_PATH: binary,
        OPENCLAW_VITEST_RUNTIME: "bun",
      };
      const selection =
        kind === "native"
          ? resolveNativeBunTestCommand(["./fixture one.test.ts"], undefined, env)
          : resolveVitestTestCommand(
              ["node_modules/vitest/vitest.mjs", "run", "fixture one.test.ts", "--shard=2/3"],
              env,
            );
      expect(selection.command).toBe(binary);
      expect(
        JSON.parse(
          execFileSync(selection.command, selection.args, {
            env: { ...env, ...selection.envOverrides },
            encoding: "utf8",
          }),
        ),
      ).toEqual(selection.args);
      expect(selection.args).toContain(
        kind === "native" ? "./fixture one.test.ts" : "fixture one.test.ts",
      );
      writeFileSync(binary, source.replace(pin.revision, "wrong-revision"));
      expect(() =>
        kind === "native"
          ? resolveNativeBunTestCommand(["./fixture.test.ts"], undefined, env)
          : resolveVitestTestCommand(["node_modules/vitest/vitest.mjs", "run"], env),
      ).toThrow("Bun revision verification failed");
    },
  );

  it.each(["bun-all", "dual-all"] as const)(
    "avoids Bun for exact post-shard Node-only membership under %s",
    (policy) => {
      const membership = path.join(tempDirs.make("post-only-"), "includes.json");
      writeFileSync(
        membership,
        JSON.stringify(["ui/src/pages/chat/chat-thread-retention.test.ts"]),
      );
      const shard = {
        configs: ["ui/vitest.config.ts"],
        vitestArgs: ["--shard=1/2"],
        env: { OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: membership },
      };
      expect(resolveCiTestRuntimeSelections(shard, policy)).toEqual([{ runtime: "node" }]);
      expect(ciTestShardRequiresBun(shard, policy)).toBe(false);
    },
  );

  it.each(["bun-all", "dual-all"] as const)(
    "preserves separate pre/post-shard mixed memberships under %s",
    async (policy) => {
      const root = tempDirs.make("mixed-memberships-");
      const pre = path.join(root, "pre.json");
      const post = path.join(root, "post.json");
      const members = [
        "ui/src/pages/chat/chat-thread-retention.test.ts",
        "ui/src/pages/chat/chat-pane-history.test.ts",
      ];
      writeFileSync(pre, JSON.stringify(members));
      writeFileSync(post, JSON.stringify(members));
      const calls: Array<{
        runtime: string | undefined;
        pre: string[];
        post: string[];
        args: string[];
      }> = [];
      await runShardPlans(
        [{ kind: "group", name: "ui", plan: { configs: ["ui/vitest.config.ts"] } }],
        {
          env: {
            OPENCLAW_CI_TEST_RUNTIME_POLICY: policy,
            OPENCLAW_VITEST_INCLUDE_FILE: pre,
            OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: post,
            OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--shard=1/2"]),
          },
          scratchDir: root,
          runChild: async (args, env) => {
            calls.push({
              runtime: env.OPENCLAW_VITEST_RUNTIME,
              args,
              pre: JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8")),
              post: JSON.parse(readFileSync(env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE!, "utf8")),
            });
            return 0;
          },
        },
      );
      expect(calls.map((c) => c.runtime)).toEqual(["node", "bun"]);
      expect(calls.every((c) => c.args.includes("--shard=1/2"))).toBe(true);
      expect(calls.map((c) => c.pre)).toEqual([members, members]);
      expect(calls.map((c) => c.post)).toEqual([
        policy === "dual-all" ? members : [members[0]],
        [members[1]],
      ]);
    },
  );
});
