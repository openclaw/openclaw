import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { stripNodeTypeScriptTypes } from "../helpers/node-toolchain.js";

const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
const adapter = source.match(/^function dispatchFullReleaseUsingHelper\([\s\S]*?^\}/mu)![0];
const quote = source.match(/^function shellQuote\([\s\S]*?^\}/mu)![0];
const candidate = "a".repeat(40);
const publisher = "b".repeat(40);
const options = {
  repo: "openclaw/openclaw",
  tag: "v2026.9.1",
  outputDir: "/private/request with spaces",
  provider: "openai",
  mode: "both",
  releaseProfile: "stable",
  publishWorkflowRef: "release-publish/bbbbbbbbbbbb-123",
  workflowRef: "main",
};

describe("candidate checklist retained dispatch recovery", () => {
  it.each([
    ["openclaw.full-release-dispatch/v2", "prepared", "intended", true],
    ["openclaw.full-release-dispatch/v2", "prepared", "uncertain", false],
    ["openclaw.full-release-dispatch/v2", "attempted", "created", false],
    ["openclaw.full-release-dispatch/v1", "prepared", "intended", false],
  ] as const)(
    "offers only the canonical recovery command for %s/%s/%s",
    (kind, phase, workflow, resumable) => {
      const run = vi.fn<(command: string, args: string[]) => string>(() => "");
      const record = {
        kind,
        phase,
        refs: { workflow },
        admission: { phase: "observed" },
        run: null,
      };
      const dispatch = runInNewContext(
        stripNodeTypeScriptTypes(adapter + "\n" + quote + "\ndispatchFullReleaseUsingHelper;"),
        {
          DEFAULT_REPO: "openclaw/openclaw",
          TOOLING_ROOT: "/trusted/publisher",
          process: { execPath: "/runtime/node" },
          existsSync: () => true,
          resolvePath: resolve,
          join,
          releaseBranchForTag: () => "release/2026.9.1",
          publicationSelectionForChecklist: () => ({ route: "normal", npmDistTag: "latest" }),
          run,
          readJson: () => record,
          isRecord,
        },
      ) as (options: object, candidate: string, publisher: string) => string;
      const flag = resumable ? "--resume-request" : "--reconcile-request";
      expect(() => dispatch(options, candidate, publisher)).toThrow(
        "Next: pnpm ci:full-release -- " +
          flag +
          " '/private/request with spaces/frv-request.json'",
      );
      expect(run).toHaveBeenCalledOnce();
      const [command, args] = run.mock.calls[0]!;
      expect(command).toBe("/runtime/node");
      expect(args[0]).toBe("/trusted/publisher/scripts/full-release-validation-at-sha.mjs");
      expect(args).toContain("--request-file");
      for (const mutationSelector of [
        "--resume-request",
        "--trusted-workflow-ref",
        "--workflow-sha",
        "--admission-workflow-sha",
      ]) {
        expect(args).not.toContain(mutationSelector);
      }
      expect(record.phase).toBe(phase);
    },
  );
});
