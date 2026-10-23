import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

it.each(
  ["repair", "finalize"].flatMap((command) =>
    ["parent", "leaf", "human"].flatMap((format) =>
      ["", "unrecognized-channel"].map((channel) => ({ command, format, channel })),
    ),
  ),
)(
  "reports invalid $command channel '$channel' in $format output",
  async ({ command, format, channel }) => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      await state.writeConfig({ update: { channel: "stable" } });
      const before = await fs.readFile(state.configPath, "utf8");
      const result = await runCliProcessChild({
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
          "update",
          ...(format === "parent" ? ["--json"] : []),
          command,
          "--channel",
          channel,
          ...(format === "leaf" ? ["--json"] : []),
        ],
        env: { ...process.env, ...state.env, OPENCLAW_TEST_RUNTIME_LOG: "1" },
      });
      const message = `--channel must be "stable", "extended-stable", "beta", or "dev" (got ${JSON.stringify(channel)})`;
      expect(result, result.stderr).toMatchObject({ code: 1, signal: null });
      expect(result.stderr.trim()).toBe(message);
      if (format === "human") {
        expect(result.stdout).toBe("");
      } else {
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: { type: "cli_error", message },
        });
      }
      expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
    });
  },
);

it.each(
  [
    { label: "update", command: undefined },
    { label: "update repair", command: "repair" },
    { label: "update finalize", command: "finalize" },
  ].flatMap(({ label, command }) =>
    ['beta"\nFORGED', 'dev\t"[error] forged'].map((channel) => ({ label, command, channel })),
  ),
)(
  "escapes quotes and control characters in the rejected $label channel diagnostic",
  async ({ command, channel }) => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      await state.writeConfig({ update: { channel: "stable" } });
      const result = await runCliProcessChild({
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
          "update",
          ...(command ? [command] : []),
          "--json",
          "--channel",
          channel,
        ],
        env: { ...process.env, ...state.env, OPENCLAW_TEST_RUNTIME_LOG: "1" },
      });
      const message = `--channel must be "stable", "extended-stable", "beta", or "dev" (got ${JSON.stringify(channel)})`;
      expect(result, result.stderr).toMatchObject({ code: 1, signal: null });
      // The rejected value is rendered as one escaped JSON string, so it cannot forge stderr lines.
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain(channel);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: { type: "cli_error", message },
      });
    });
  },
);
