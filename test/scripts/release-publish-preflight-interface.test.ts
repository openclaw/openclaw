import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReleasePublishDispatchCommand,
  formatReleasePublishPreflight,
  parsePublishPreflightArgs,
} from "../../scripts/lib/release-publish-preflight-interface.mts";

describe("release publish preflight operator interface", () => {
  it.skipIf(process.platform === "win32")(
    "prints a shell-safe POSIX dispatch that preserves waiver and exact resume inputs",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "publish-dispatch-"));
      try {
        const output = join(dir, "arguments.json");
        const executable = join(dir, "gh");
        writeFileSync(
          executable,
          `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`,
        );
        chmodSync(executable, 0o755);
        const waiver = "Owner's approved reason\n$(touch should-not-exist); `false`";
        const command = buildReleasePublishDispatchCommand(
          {
            repo: "openclaw/openclaw",
            tag: "v2026.9.5",
            workflowRef: "main",
            fullReleaseValidationRunId: "123",
            npmDistTag: "latest",
            pluginPublishScope: "all-publishable",
            stableSoakWaiver: waiver,
          },
          "2",
          "release-publish/aaaaaaaaaaaa-123",
          "456",
        );
        execFileSync("/bin/sh", ["-c", command], {
          cwd: dir,
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        });
        const args = JSON.parse(readFileSync(output, "utf8"));
        expect(args).toContain(`stable_soak_waiver=${waiver}`);
        expect(args).toContain("full_release_validation_run_attempt=2");
        expect(args).toContain("openclaw_npm_resume_run_id=456");
        expect(args).toContain("release-publish/aaaaaaaaaaaa-123");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["maybe", "TRUE", "0"])(
    "rejects ambiguous publish-openclaw-npm=%s before observation",
    (value) => {
      expect(() =>
        parsePublishPreflightArgs([
          "--tag",
          "v2026.9.5",
          "--workflow-ref",
          "main",
          "--publish-openclaw-npm",
          value,
        ]),
      ).toThrow("must be true or false");
    },
  );

  it("accepts selected plugin repair inputs without inventing core publication", () => {
    const parsed = parsePublishPreflightArgs([
      "--tag",
      "v2026.9.5",
      "--workflow-ref",
      "release-publish/aaaaaaaaaaaa-123",
      "--publish-openclaw-npm",
      "false",
      "--plugin-publish-scope",
      "selected",
      "--plugins",
      "@openclaw/example",
    ]);
    expect(parsed?.options).toMatchObject({
      publishOpenclawNpm: false,
      pluginPublishScope: "selected",
      plugins: "@openclaw/example",
    });
  });

  it("retains failure and remediation in the table without duplicating a prepared command", () => {
    const text = formatReleasePublishPreflight(
      {
        rows: [
          {
            id: "publisher.soak",
            status: "FAIL",
            message: "Missing soak | evidence",
            remediation: "Run soak\nor supply the operator reason",
          },
        ],
        command: "gh workflow run ...",
        failed: true,
      },
      { includeCommand: false },
    );
    expect(text).toContain("| FAIL | publisher.soak |");
    expect(text).toContain("Missing soak \\| evidence");
    expect(text).toContain("Run soak or supply the operator reason");
    expect(text).toContain("Resolve FAIL rows");
    expect(text).not.toContain("gh workflow run");
  });
});
