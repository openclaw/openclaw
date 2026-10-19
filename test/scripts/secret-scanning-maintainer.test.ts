// Secret Scanning Maintainer tests cover secret scanning maintainer script behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const scriptPath = ".agents/skills/openclaw-secret-scanning-maintainer/scripts/secret-scanning.mjs";
const { createTempDir } = createScriptTestHarness();

describe("secret scanning maintainer script", () => {
  it.each([
    ["issue_body", "Issue", "issue_number"],
    ["pull_request_body", "PullRequest", "pr_number"],
    ["pull_request_review_comment", "PullRequestReviewComment", "issue_number"],
  ])(
    "keeps %s content private while reporting identity and edit history",
    (type, nodeType, numberKey) => {
      const tempDir = createTempDir("openclaw-secret-scan-content-");
      const ghPath = path.join(tempDir, "gh");
      const fixturePath = path.join(tempDir, "content.json");
      const body = "synthetic private content\n";
      const htmlUrl = "https://github.com/openclaw/openclaw/pull/123";
      fs.writeFileSync(
        fixturePath,
        JSON.stringify({
          id: 456,
          node_id: "fixture-node",
          number: 123,
          user: { login: "contributor" },
          body,
          html_url: htmlUrl,
          merged: false,
          state: "open",
        }),
      );
      fs.writeFileSync(
        ghPath,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "api") process.exit(1);
if (args[1] === "graphql") {
  if (!args.join(" ").includes("... on " + process.env.EXPECTED_NODE_TYPE)) process.exit(2);
  console.log(JSON.stringify({ data: { node: { userContentEdits: { totalCount: 3 } } } }));
} else {
  process.stdout.write(fs.readFileSync(process.env.CONTENT_FIXTURE, "utf8"));
}
`,
        { mode: 0o755 },
      );
      const output = execFileSync(
        process.execPath,
        [
          scriptPath,
          "fetch-content",
          JSON.stringify({ type, details: { [`${type}_url`]: "https://api.github.com/fixture" } }),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            TMPDIR: tempDir,
            OPENCLAW_GH_BIN: ghPath,
            PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
            EXPECTED_NODE_TYPE: nodeType,
            CONTENT_FIXTURE: fixturePath,
          },
        },
      );
      const result = JSON.parse(output);
      expect(result).toEqual({
        type,
        ...(type === "pull_request_review_comment" ? { comment_id: 456 } : {}),
        [numberKey]: type === "pull_request_review_comment" ? "123" : 123,
        node_id: "fixture-node",
        author: "contributor",
        ...(type === "pull_request_body" ? { merged: false, state: "open" } : {}),
        html_url: htmlUrl,
        edit_history_count: 3,
        body_file: expect.any(String),
      });
      expect(output).not.toContain(body.trim());
      expect(fs.readFileSync(result.body_file, "utf8")).toBe(body);
      expect(fs.statSync(result.body_file).mode & 0o777).toBe(0o600);
    },
  );

  it("marks body alerts as not requiring notification when redaction is unchanged", () => {
    const tempDir = createTempDir("openclaw-secret-scan-");
    const currentBody = path.join(tempDir, "current.md");
    const redactedBody = path.join(tempDir, "redacted.md");
    const resultFile = path.join(tempDir, "redaction-result.json");
    fs.writeFileSync(currentBody, "token: [REDACTED Discord Bot Token]\n");
    fs.writeFileSync(redactedBody, "token: [REDACTED Discord Bot Token]\n");

    const output = execFileSync(
      process.execPath,
      [scriptPath, "redact-body-if-needed", "issue", "123", currentBody, redactedBody, resultFile],
      { encoding: "utf8" },
    );

    expect(JSON.parse(output)).toMatchObject({
      body_changed: false,
      notify_required: false,
      reason: "current_body_already_redacted",
      redacted: false,
    });
    expect(JSON.parse(fs.readFileSync(resultFile, "utf8"))).toMatchObject({
      notify_required: false,
    });
  });

  it("patches body alerts and requires notification when redaction changes the current body", () => {
    const tempDir = createTempDir("openclaw-secret-scan-");
    const binDir = path.join(tempDir, "bin");
    const ghLog = path.join(tempDir, "gh.log");
    const ghPath = path.join(binDir, "gh");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      ghPath,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${ghLog}"\nprintf '{}\\n'\n`,
      { mode: 0o755 },
    );

    const currentBody = path.join(tempDir, "current.md");
    const redactedBody = path.join(tempDir, "redacted.md");
    const resultFile = path.join(tempDir, "redaction-result.json");
    fs.writeFileSync(currentBody, "token: plaintext-secret\n");
    fs.writeFileSync(redactedBody, "token: [REDACTED Discord Bot Token]\n");

    const output = execFileSync(
      process.execPath,
      [scriptPath, "redact-body-if-needed", "issue", "123", currentBody, redactedBody, resultFile],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_GH_BIN: ghPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(JSON.parse(output)).toMatchObject({
      body_changed: true,
      notify_required: true,
      redacted: true,
    });
    expect(fs.readFileSync(ghLog, "utf8")).toContain(
      `api repos/openclaw/openclaw/issues/123 -X PATCH -F body=@${redactedBody}`,
    );
  });

  it("skips body notification when the redaction result says the current body was already redacted", () => {
    const tempDir = createTempDir("openclaw-secret-scan-");
    const resultFile = path.join(tempDir, "redaction-result.json");
    fs.writeFileSync(
      resultFile,
      JSON.stringify({
        body_changed: false,
        notify_required: false,
      }),
    );

    const output = execFileSync(
      process.execPath,
      [scriptPath, "notify", "123", "contributor", "issue_body", "Discord Bot Token", resultFile],
      { encoding: "utf8" },
    );

    expect(JSON.parse(output)).toStrictEqual({
      ok: true,
      reason: "current_body_already_redacted",
      skipped: true,
    });
  });

  it("requires body notifications to include a redaction result file", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [scriptPath, "notify", "123", "contributor", "issue_body", "Discord Bot Token"],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow(/Body notifications require a redaction result file/);
  });
});
