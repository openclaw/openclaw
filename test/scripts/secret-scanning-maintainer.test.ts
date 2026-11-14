import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const scriptPath = ".agents/skills/openclaw-secret-scanning-maintainer/scripts/secret-scanning.mjs";
const { createTempDir } = createScriptTestHarness();
const notificationArgs = ["notify", "123", "contributor", "issue_body", "Discord Bot Token"];

function run(args: string[], env: NodeJS.ProcessEnv) {
  return execFileSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", env });
}

function ghEnv(root: string) {
  return {
    HOME: root,
    GH_CONFIG_DIR: root,
    GH_TOKEN: "synthetic-test-token",
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
  const body = "synthetic private content\n";
  const htmlUrl = "https://github.com/openclaw/openclaw/pull/123";
  const content = JSON.stringify({
    id: 456,
    node_id: "fixture-node",
    number: 123,
    user: { login: "contributor" },
    body,
    html_url: htmlUrl,
    merged: false,
    state: "open",
  });
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "api") process.exit(1);
if (args[1] === "graphql") {
  if (!args.join(" ").includes(${JSON.stringify("... on " + nodeType)})) process.exit(2);
  console.log(JSON.stringify({ data: { node: { userContentEdits: { totalCount: 3 } } } }));
} else {
  process.stdout.write(${JSON.stringify(content)});
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
    expect(JSON.parse(run([...notificationArgs, resultFile], ghEnv(root)))).toStrictEqual({
      ok: true,
      reason: "current_body_already_redacted",
      skipped: true,
    });
  }
});

it.each([
  { args: notificationArgs, error: /Body notifications require a redaction result file/ },
  { args: ["resolve"], error: /Usage:/ },
  { args: ["resolve", "123"], error: /Usage:/ },
  { args: ["resolve", "123", "pattern_deleted"], error: /Invalid resolution:/ },
  { args: ["resolve", "123", "rotated"], error: /Invalid resolution:/ },
])(
  "refuses incomplete or unsupported maintenance requests before invoking GitHub: $args",
  ({ args, error }) => {
    const root = createTempDir("openclaw-secret-scan-resolution-");
    const ghLog = path.join(root, "gh.log");
    fs.writeFileSync(path.join(root, "gh"), `#!/bin/sh\ntouch "${ghLog}"\necho '{}'\n`, {
      mode: 0o755,
    });
    expect(() => run(args, ghEnv(root))).toThrow(error);
    expect(fs.existsSync(ghLog)).toBe(false);
  },
);

it.each([
  { resolution: "revoked", comment: "Issuer confirmed revocation." },
  { resolution: "false_positive", comment: "Detection reviewed as a false positive." },
  { resolution: "used_in_tests", comment: "Confirmed synthetic test credential." },
  { resolution: "wont_fix" },
])(
  "forwards the explicit $resolution resolution without inventing evidence",
  ({ resolution, comment }) => {
    const root = createTempDir("openclaw-secret-scan-resolution-");
    const ghLog = path.join(root, "gh.json");
    fs.writeFileSync(
      path.join(root, "gh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "api") process.exit(1);
fs.writeFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args));
console.log(JSON.stringify({ number: 123, state: "resolved", resolution: ${JSON.stringify(resolution)} }));
`,
      { mode: 0o755 },
    );
    const output = run(["resolve", "123", resolution, ...(comment ? [comment] : [])], ghEnv(root));
    expect(JSON.parse(output)).toEqual({ ok: true, number: 123, state: "resolved", resolution });
    expect(JSON.parse(fs.readFileSync(ghLog, "utf8"))).toEqual([
      "api",
      "repos/openclaw/openclaw/secret-scanning/alerts/123",
      "-X",
      "PATCH",
      "-f",
      "state=resolved",
      "-f",
      `resolution=${resolution}`,
      ...(comment ? ["-f", `resolution_comment=${comment}`] : []),
    ]);
  },
);
