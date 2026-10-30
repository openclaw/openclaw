import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import {
  buildReleasePublishDispatchCommand,
  formatReleasePublishPreflight,
  parsePublishPreflightArgs as parseArgs,
} from "../../scripts/lib/release-publish-preflight-interface.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const dispatchOptions = {
  repo: "openclaw/openclaw",
  workflowRef: "main",
  fullReleaseValidationRunId: "123",
  pluginPublishScope: "all-publishable" as const,
};
const toolingRef = "release-publish/aaaaaaaaaaaa-123";
const parse = (extra: string) =>
  parseArgs(["--tag", "v2026.9.5", ...extra.split(" ").filter(Boolean)])?.options;
type DispatchInput = Omit<
  Parameters<typeof buildReleasePublishDispatchCommand>[0],
  keyof typeof dispatchOptions
>;
const dispatch = (input: DispatchInput, attempt = "1", resume = "") =>
  buildReleasePublishDispatchCommand({ ...dispatchOptions, ...input }, attempt, toolingRef, resume);

it("parses exact tooling and selected plugin repair inputs", () => {
  const sha = "a".repeat(40);
  expect(parse(`--workflow-sha ${sha}`)).toMatchObject({
    workflowRef: "",
    workflowSha: sha,
  });
  expect(
    parse(
      `--workflow-ref ${toolingRef} --publish-openclaw-npm false --plugin-publish-scope selected --plugins @openclaw/example`,
    ),
  ).toMatchObject({
    publishOpenclawNpm: false,
    pluginPublishScope: "selected",
    plugins: "@openclaw/example",
  });
});

it("rejects invalid selectors, publication booleans, and retired bypasses", () => {
  const rejects = (args: string, error?: string) => expect(() => parse(args)).toThrow(error);
  const selectorError = "--tag and exactly one of --workflow-ref or --workflow-sha are required.";
  rejects("", selectorError);
  rejects(`--workflow-ref main --workflow-sha ${"a".repeat(40)}`, selectorError);
  rejects(
    `--workflow-sha ${"A".repeat(12)}`,
    "--workflow-sha must be a lowercase 40-character commit SHA.",
  );
  for (const flag of ["--stable-soak-waiver", "--lane-waiver"]) {
    rejects(`--workflow-ref main ${flag} approved`);
  }
  rejects("--workflow-ref main --publish-openclaw-npm TRUE", "must be true or false");
});

it.skipIf(process.platform === "win32")(
  "prints a shell-safe POSIX dispatch that preserves artifact and exact resume inputs",
  () => {
    const dir = tempDirs.make("publish-dispatch-");
    const installerDigests = "Owner's approved reason\n$(touch should-not-exist); `false`";
    const latest = {
      tag: "v2026.9.5",
      npmDistTag: "latest",
      windowsNodeInstallerDigests: installerDigests,
    };
    const command = dispatch(latest, "2", "456");
    const args = execFileSync("/bin/sh", ["-c", `gh() { printf '%s\\0' "$@"; }\n${command}`], {
      cwd: dir,
      encoding: "utf8",
    }).split("\0");
    expect(args).toContain(`windows_node_installer_digests=${installerDigests}`);
    expect(args).toContain("full_release_validation_run_attempt=2");
    expect(args).toContain("openclaw_npm_resume_run_id=456");
    expect(args).toContain(toolingRef);
    expect(args).toContain("finalize_release_before_docker=true");
  },
);

it("keeps non-latest publication behind Docker before GitHub activation", () => {
  const command = dispatch({ tag: "v2026.9.5", npmDistTag: "beta" });
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
