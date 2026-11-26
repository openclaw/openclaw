import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { node, repository, root } from "./prepare.test-support.js";
import { prepareUpdate } from "./run.js";

export function registerAlreadyCurrentUpdateTests() {
  describe("already-current update", () => {
    const pluginResult = (overrides: object) => ({
      status: "ok",
      changed: false,
      warnings: [],
      sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
      npm: { changed: false, outcomes: [] },
      integrityDrifts: [],
      ...overrides,
    });
    const linked =
      'Retained linked plugin "irc" at extensions/irc; update this plugin at its source.';

    it.each([
      {
        name: "a change despite a runtime security warning",
        result: pluginResult({ changed: true }),
        changed: true,
        detail: undefined,
        exitCode: 0,
      },
      {
        // The existing updater's warning result is a note, not a failed step.
        name: "a warning note",
        result: pluginResult({
          status: "warning",
          sync: {
            changed: false,
            switchedToBundled: [],
            switchedToNpm: [],
            warnings: [linked],
            errors: [],
          },
        }),
        changed: false,
        detail: linked,
        exitCode: 0,
      },
      {
        name: "a required plugin failure without replacing the current core",
        result: pluginResult({ status: "error", reason: "fixture plugin update failed" }),
        changed: false,
        detail: "fixture plugin update failed\nRun `openclaw plugins update --all` to retry.",
        exitCode: 0,
      },
      {
        name: "the CLI refusal after a runtime security warning",
        result: pluginResult({ status: "error" }),
        changed: false,
        detail:
          "OpenClaw refused shared state schema mutation because another Gateway owns that state directory.\nRun `openclaw plugins update --all` to retry.",
        exitCode: 1,
      },
    ])("still maintains plugins with the serving code and records $name", async (expected) => {
      const { checkout, sha } = await repository();
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      // The serving build was made from the target commit.
      vi.stubEnv("GIT_COMMIT", sha);
      // The serving release's own `update plugins`: records its argv and prints its result.
      await fs.writeFile(
        path.join(checkout, "openclaw.mjs"),
        [
          "import fs from 'node:fs';",
          "fs.writeFileSync('plugins-argv.json', JSON.stringify(process.argv.slice(2)));",
          "process.stderr.write('openclaw: SECURITY WARNING: upgrade Node to the recommended security patch level.\\n');",
          expected.exitCode === 0
            ? `console.log(${JSON.stringify(JSON.stringify(expected.result))});`
            : "process.stderr.write('[openclaw] The CLI command failed.\\n[openclaw] Reason: OpenClaw refused shared state schema mutation because another Gateway owns that state directory.\\n[openclaw] Another OpenClaw process is using your data. Wait for it to finish before trying again.\\n');",
          `process.exitCode = ${expected.exitCode};`,
        ].join("\n"),
      );
      try {
        openOpenClawStateDatabase({ env: process.env });
        const run = await createUpdateRunAsync({
          trigger: "cli",
          before: { version: "2026.11.21" },
        });
        const outcome = await prepareUpdate({
          runId: run.runId,
          runningRoot: checkout,
          runningVersion: "2026.11.21",
          channel: "dev",
          sha,
          node,
          acceptCapabilities: expected.changed,
        });
        expect(outcome).toMatchObject({ status: "current", pluginsChanged: expected.changed });
        expect(
          JSON.parse(await fs.readFile(path.join(checkout, "plugins-argv.json"), "utf8")),
        ).toEqual([
          "update",
          "plugins",
          "--json",
          "--channel",
          "dev",
          "--timeout",
          expect.stringMatching(/^\d+$/),
          ...(expected.changed ? ["--accept-capabilities"] : []),
        ]);
        const record = await getUpdateRunAsync(run.runId);
        expect(record).toMatchObject({ status: "skipped", reason: "already-current" });
        const plugins = record?.steps.find(({ step }) => step === "plugins");
        expect(plugins?.status).toBe(expected.result.status === "error" ? "failed" : "completed");
        expect(plugins?.detail).toBe(expected.detail);
      } finally {
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
      }
    });
  });
}
