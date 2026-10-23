import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const scriptPath = ".agents/skills/openclaw-secret-scanning-maintainer/scripts/secret-scanning.mjs";
const { createTempDir } = createScriptTestHarness();
const notificationArgs = ["notify", "123", "contributor", "issue_body", "Discord Bot Token"];

function run(args: string[], env?: NodeJS.ProcessEnv) {
  return execFileSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", env });
}

function ghEnv(root: string) {
  return {
    ...process.env,
    OPENCLAW_GH_BIN: path.join(root, "gh"),
    PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

it.each([
  ["issue_body", "Issue", "issue_number"],
  ["pull_request_body", "PullRequest", "pr_number"],
  ["pull_request_review_comment", "PullRequestReviewComment", "issue_number"],
])("keeps %s private with identity and edit history", (type, nodeType, numberKey) => {
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
  const output = run(
    [
      "fetch-content",
      JSON.stringify({ type, details: { [`${type}_url`]: "https://api.github.com/fixture" } }),
    ],
    {
      ...ghEnv(tempDir),
      TMPDIR: tempDir,
      EXPECTED_NODE_TYPE: nodeType,
      CONTENT_FIXTURE: fixturePath,
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
});

it.each([false, true])("notifies only for changed redaction: %s", (changed) => {
  const body = "token: [REDACTED Discord Bot Token]\n";
  const root = createTempDir("openclaw-secret-scan-");
  const currentBody = path.join(root, "current.md");
  const redactedBody = path.join(root, "redacted.md");
  const resultFile = path.join(root, "redaction-result.json");
  fs.writeFileSync(currentBody, changed ? "token: plaintext-secret\n" : body);
  fs.writeFileSync(redactedBody, body);
  const ghLog = path.join(root, "gh.log");
  fs.writeFileSync(
    path.join(root, "gh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${ghLog}"\nprintf '{}\\n'\n`,
    { mode: 0o755 },
  );
  const output = run(
    ["redact-body-if-needed", "issue", "123", currentBody, redactedBody, resultFile],
    ghEnv(root),
  );
  expect(JSON.parse(output)).toMatchObject({
    body_changed: changed,
    notify_required: changed,
    redacted: changed,
    ...(!changed ? { reason: "current_body_already_redacted" } : {}),
  });
  if (changed) {
    expect(fs.readFileSync(ghLog, "utf8")).toContain(
      `api repos/openclaw/openclaw/issues/123 -X PATCH -F body=@${redactedBody}`,
    );
  } else {
    expect(JSON.parse(fs.readFileSync(resultFile, "utf8"))).toMatchObject({
      notify_required: false,
    });
  }
});

it.each([false, true])("gates body notifications on redaction metadata: %s", (provided) => {
  const tempDir = createTempDir("openclaw-secret-scan-");
  const resultFile = path.join(tempDir, "redaction-result.json");
  fs.writeFileSync(resultFile, JSON.stringify({ body_changed: false, notify_required: false }));
  const notify = () => run([...notificationArgs, ...(provided ? [resultFile] : [])]);
  if (provided) {
    expect(JSON.parse(notify())).toStrictEqual({
      ok: true,
      reason: "current_body_already_redacted",
      skipped: true,
    });
  } else {
    expect(notify).toThrow(/Body notifications require a redaction result file/);
  }
});
