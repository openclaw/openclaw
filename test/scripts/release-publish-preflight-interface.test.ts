import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  buildReleasePublishDispatchCommand,
  formatReleasePublishPreflight,
  parsePublishPreflightArgs as parseArgs,
} from "../../scripts/lib/release-publish-preflight-interface.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import * as fixtureIO from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const dispatchOptions = {
  repo: "openclaw/openclaw",
  workflowRef: "main",
  fullReleaseValidationRunId: "123",
  pluginPublishScope: "all-publishable" as const,
};
const toolingRef = "release-publish/aaaaaaaaaaaa-123";
const parse = (extra: string[]) => parseArgs(["--tag", "v2026.9.5", ...extra])?.options;
type DispatchInput = Omit<
  Parameters<typeof buildReleasePublishDispatchCommand>[0],
  keyof typeof dispatchOptions
>;
const dispatch = (input: DispatchInput, attempt = "1", resume = "") =>
  buildReleasePublishDispatchCommand({ ...dispatchOptions, ...input }, attempt, toolingRef, resume);

it("parses exact tooling and selected plugin repair inputs", () => {
  const sha = "a".repeat(40);
  expect(parse(["--workflow-sha", sha])).toMatchObject({
    workflowRef: "",
    workflowSha: sha,
  });
  const selected =
    `--workflow-ref ${toolingRef} --publish-openclaw-npm false --plugin-publish-scope selected --plugins @openclaw/example`.split(
      " ",
    );
  expect(parse(selected)).toMatchObject({
    publishOpenclawNpm: false,
    pluginPublishScope: "selected",
    plugins: "@openclaw/example",
  });
});

it("rejects invalid selectors, publication booleans, and retired bypasses", () => {
  const selectorError = "--tag and exactly one of --workflow-ref or --workflow-sha are required.";
  const cases: { flags: string[]; error?: string }[] = [
    { flags: [], error: selectorError },
    { flags: ["--workflow-ref", "main", "--workflow-sha", "a".repeat(40)], error: selectorError },
    ...["a".repeat(12), "A".repeat(40), "g".repeat(40)].map((sha) => ({
      flags: ["--workflow-sha", sha],
      error: "--workflow-sha must be a lowercase 40-character commit SHA.",
    })),
    ...["--stable-soak-waiver", "--lane-waiver"].map((flag) => ({
      flags: ["--workflow-ref", "main", flag, "2026.9.5 approved"],
    })),
    ...["TRUE", "0"].map((value) => ({
      flags: ["--workflow-ref", "main", "--publish-openclaw-npm", value],
      error: "must be true or false",
    })),
  ];
  for (const { flags: args, error } of cases) {
    expect(() => parse(args)).toThrow(error);
  }
});

it.skipIf(process.platform === "win32")(
  "prints a shell-safe POSIX dispatch that preserves artifact and exact resume inputs",
  () => {
    const dir = tempDirs.make("publish-dispatch-");
    const output = join(dir, "arguments.json");
    const executable = join(dir, "gh");
    fixtureIO.writeExecutable(
      executable,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    const installerDigests = "Owner's approved reason\n$(touch should-not-exist); `false`";
    const latest = {
      tag: "v2026.9.5",
      npmDistTag: "latest",
      windowsNodeInstallerDigests: installerDigests,
    };
    const command = dispatch(latest, "2", "456");
    execFileSync("/bin/sh", ["-c", command], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    const args = fixtureIO.readJson(output);
    expect(args).toContain(`windows_node_installer_digests=${installerDigests}`);
    expect(args).toContain("full_release_validation_run_attempt=2");
    expect(args).toContain("openclaw_npm_resume_run_id=456");
    expect(args).toContain(toolingRef);
    expect(args).toContain("finalize_release_before_docker=true");
  },
);

it.each([
  { tag: "v2026.9.5", npmDistTag: "beta" },
  { tag: "v2026.8.33", npmDistTag: "extended-stable" },
])("keeps $tag on $npmDistTag behind Docker before GitHub activation", (input) => {
  const command = dispatch(input);
  expect(command).not.toContain("finalize_release_before_docker");
});

it("retains failure and remediation in the table without duplicating a prepared command", () => {
  const failure = {
    id: "publisher.soak",
    status: "FAIL" as const,
    message: "Missing soak | evidence",
    remediation: "Run soak\nand reseal validation",
  };
  const text = formatReleasePublishPreflight(
    { rows: [failure], command: "gh workflow run ...", failed: true },
    { includeCommand: false },
  );
  expect(text).toContain("| FAIL | publisher.soak |");
  expect(text).toContain("Missing soak \\| evidence");
  expect(text).toContain("Run soak and reseal validation");
  expect(text).toContain("Resolve FAIL rows");
  expect(text).not.toContain("gh workflow run");
});
