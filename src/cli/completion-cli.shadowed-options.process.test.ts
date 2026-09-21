import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import {
  itWithFish,
  itWithPowerShell,
  PowerShellCompletionRunner,
  runBashCompletionScript,
  runFishCompletionScript,
} from "./completion-cli.test-support.js";
import { writeCompletionPluginFixture } from "./completion-plugin-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cases = [
  { suffix: "group --mode show --j", expected: ["--json"] },
  { suffix: "--mode work group show --j", expected: ["--json"] },
  { suffix: "--mode group group show --j", expected: ["--json"] },
  { suffix: "--mode work group --mode show --j", expected: ["--json"] },
  { suffix: "--mode=work group --mode show --j", expected: ["--json"] },
  { suffix: "-m work g --mode show --j", expected: ["--json"] },
  { suffix: "-m group group show --j", expected: ["--json"] },
  { suffix: "group pick --mode lo", expected: ["local"] },
  { suffix: "group pick --mode local --j", expected: ["--json"] },
  { suffix: "group show --hid", expected: [] },
];

describe("registered completion CLI with configured plugin option shadowing", () => {
  for (const [shell, nativeTest] of [
    ["bash", it.skipIf(process.platform === "win32")],
    ["fish", itWithFish],
    ["powershell", itWithPowerShell],
  ] as const) {
    nativeTest(
      `loads api.registerCli and preserves nearest option ownership in ${shell}`,
      async () => {
        const root = tempDirs.make("openclaw-completion-options-");
        const fixture = await writeCompletionPluginFixture(root);
        const result = await runCliProcessChild({
          nodeArgs: [
            ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
            "completion",
            "--shell",
            shell,
          ],
          env: fixture.env,
        });
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
        expect(result.stdout).toContain("proof-required");
        expect(result.stdout).toContain("proof-optional");
        const runner = new PowerShellCompletionRunner();
        try {
          for (const kind of ["required", "optional"]) {
            for (const { suffix, expected } of cases) {
              const line = `openclaw proof-${kind} ${suffix}`;
              const actual =
                shell === "bash"
                  ? runBashCompletionScript(result.stdout, line.split(" "))
                  : shell === "fish"
                    ? runFishCompletionScript(result.stdout, line)
                    : await runner.completeScript(result.stdout, line);
              expect(actual, line).toEqual(expected);
            }
          }
          await expect(fs.stat(fixture.marker)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await runner.close();
        }
      },
    );
  }

  it.each(["required", "optional"])(
    "the ordinary plugin CLI parses the %s parent's child boolean without consuming show",
    async (kind) => {
      const root = tempDirs.make("openclaw-completion-parser-");
      const fixture = await writeCompletionPluginFixture(root);
      const result = await runCliProcessChild({
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
          `proof-${kind}`,
          "group",
          "--mode",
          "show",
          "--json",
        ],
        env: fixture.env,
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(await fs.readFile(fixture.marker, "utf8"))).toEqual({
        parent: {},
        group: { mode: true },
        options: { json: true },
      });
    },
  );
});
