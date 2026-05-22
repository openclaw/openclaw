import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = path.resolve("scripts/crabbox/pr-desktop-lease.mjs");
const currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const staleHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "crabbox-pr-desktop-lease-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, source: string) {
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
}

function parseCalls(callsPath: string): Array<{ args: string[]; tool: string }> {
  return readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; tool: string });
}

function normalizeComment(comment: Record<string, unknown> | string, index: number) {
  return typeof comment === "string"
    ? { body: comment, id: index + 1, user: { login: "github-actions[bot]" } }
    : comment;
}

function normalizeCommentsPayload(
  comments:
    | Array<Record<string, unknown> | string>
    | Array<Array<Record<string, unknown> | string>>,
) {
  if (Array.isArray(comments[0])) {
    return (comments as Array<Array<Record<string, unknown> | string>>).map((page, pageIndex) =>
      page.map((comment, commentIndex) =>
        normalizeComment(comment, pageIndex * 100 + commentIndex),
      ),
    );
  }
  return (comments as Array<Record<string, unknown> | string>).map(normalizeComment);
}

function runLeaseScript(
  payload: Record<string, string>,
  comments:
    | Array<Record<string, unknown> | string>
    | Array<Array<Record<string, unknown> | string>> = [],
  env: Record<string, string> = {},
) {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  const callsPath = path.join(dir, "calls.jsonl");
  const commentBodyPath = path.join(dir, "comment.md");
  const eventPath = path.join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({ client_payload: payload }));
  writeFileSync(callsPath, "");

  writeExecutable(
    path.join(binDir, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify({ tool: "gh", args }) + "\\n");
	const apiPath = args.find((arg) => arg.startsWith("repos/")) || "";
	if (args[0] === "pr" && args[1] === "view") {
	  console.log(JSON.stringify({ state: process.env.PR_STATE || "OPEN", headRefOid: process.env.PR_HEAD_SHA || "new-head" }));
	  process.exit(0);
	}
if (args[0] === "api" && apiPath.includes("/comments?")) {
  console.log(process.env.PR_COMMENTS || "[]");
  process.exit(0);
}
if (args[0] === "api" && apiPath.includes("/issues/comments/")) {
  const bodyArg = args.find((arg) => arg.startsWith("body=@"));
  fs.writeFileSync(process.env.COMMENT_BODY_PATH, bodyArg ? fs.readFileSync(bodyArg.slice(6), "utf8") : "");
  process.exit(0);
}
if (args[0] === "api" && apiPath.endsWith("/comments")) {
  const bodyArg = args.find((arg) => arg.startsWith("body=@"));
  fs.writeFileSync(process.env.COMMENT_BODY_PATH, bodyArg ? fs.readFileSync(bodyArg.slice(6), "utf8") : "");
  process.exit(0);
}
console.error("unexpected gh args", args.join(" "));
process.exit(2);
`,
  );

  writeExecutable(
    path.join(binDir, "crabbox"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify({ tool: "crabbox", args }) + "\\n");
		if (args[0] === "inspect") {
		  const sequence = process.env.INSPECT_STDOUTS ? JSON.parse(process.env.INSPECT_STDOUTS) : null;
		  if (sequence) {
		    const countPath = process.env.INSPECT_COUNT_PATH;
		    const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
		    fs.writeFileSync(countPath, String(count + 1));
		    console.log(sequence[Math.min(count, sequence.length - 1)]);
		    process.exit(0);
		  }
		  if (process.env.INSPECT_STATUS) {
		    console.error(process.env.INSPECT_STDERR || "inspect failed");
		    process.exit(Number(process.env.INSPECT_STATUS));
		  }
		  console.log(process.env.INSPECT_STDOUT || JSON.stringify({ state: "active", status: "running" }));
		  process.exit(0);
		}
	if (args[0] === "warmup") {
	  if (process.env.WARMUP_STATUS) {
	    console.error("warmup failed");
	    process.exit(Number(process.env.WARMUP_STATUS));
	  }
	  console.log("lease ready cbx_test123");
	  process.exit(0);
	}
	if (args[0] === "stop" && process.env.STOP_STATUS) {
	  console.error("stop failed");
	  process.exit(Number(process.env.STOP_STATUS));
	}
		if (args[0] === "webvnc" && args[1] === "status") {
		  const sequence = process.env.WEBVNC_STATUS_STDOUTS ? JSON.parse(process.env.WEBVNC_STATUS_STDOUTS) : null;
		  if (sequence) {
		    const countPath = process.env.WEBVNC_STATUS_COUNT_PATH;
		    const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
		    fs.writeFileSync(countPath, String(count + 1));
		    console.log(sequence[Math.min(count, sequence.length - 1)]);
		  } else {
		    console.log(process.env.WEBVNC_STATUS_STDOUT || "portal bridge: connected=true viewers=0 observers=0 slots=2");
		  }
		  process.exit(0);
		}
process.exit(0);
`,
  );

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CALLS_PATH: callsPath,
      COMMENT_BODY_PATH: commentBodyPath,
      CRABBOX_COORDINATOR: "https://crabbox.example.test",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_ACTIONS: "",
      CRABBOX_PR_DESKTOP_LEASE_WEBVNC_READY_POLL_MS: "1",
      CRABBOX_PR_DESKTOP_LEASE_WEBVNC_READY_TIMEOUT_MS: "25",
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      PR_COMMENTS: JSON.stringify(normalizeCommentsPayload(comments)),
      PR_HEAD_SHA: currentHead,
      INSPECT_COUNT_PATH: path.join(dir, "inspect-count"),
      WEBVNC_STATUS_COUNT_PATH: path.join(dir, "webvnc-status-count"),
      ...env,
    },
  });

  return {
    calls: parseCalls(callsPath),
    commentBody: result.status === 0 ? readFileSync(commentBodyPath, "utf8") : "",
    result,
  };
}

describe("scripts/crabbox/pr-desktop-lease", () => {
  it("uses the active lease provider for stop even when the requested PR head is stale", () => {
    const activeComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_active`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      "WebVNC: https://crabbox.example.test/portal/leases/cbx_active/vnc",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "stop",
        head_sha: staleHead,
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [activeComment],
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: ["inspect", "--provider", "azure", "--target", "linux", "--id", "cbx_active", "--json"],
    });
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: ["stop", "--provider", "azure", "cbx_active"],
    });
    expect(commentBody).toContain("Stopped the Crabbox linux desktop lease");
    expect(commentBody).toContain("- Provider: `azure`");
  });

  it("does not create a new lease when a requested PR head is stale", () => {
    const { calls, commentBody, result } = runLeaseScript({
      action: "lease",
      head_sha: staleHead,
      item_number: "85136",
      platform: "mac",
      provider: "aws",
      target_repo: "openclaw/openclaw",
      ttl_minutes: "60",
    });

    expect(result.status).toBe(0);
    expect(calls.filter((call) => call.tool === "crabbox")).toEqual([]);
    expect(commentBody).toContain(`PR head changed from ${staleHead} to ${currentHead}`);
  });

  it("uses the workflow-resolved PR head when the payload omits head_sha", () => {
    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "lease",
        item_number: "85136",
        platform: "mac",
        provider: "aws",
        target_repo: "openclaw/openclaw",
        ttl_minutes: "60",
      },
      [],
      { CRABBOX_PR_DESKTOP_LEASE_HEAD_SHA: staleHead },
    );

    expect(result.status).toBe(0);
    expect(calls.filter((call) => call.tool === "crabbox")).toEqual([]);
    expect(commentBody).toContain(`PR head changed from ${staleHead} to ${currentHead}`);
  });

  it("creates mac leases with AWS on-demand desktop semantics", () => {
    const { calls, commentBody, result } = runLeaseScript({
      action: "lease",
      head_sha: currentHead,
      item_number: "85136",
      platform: "mac",
      provider: "aws",
      target_repo: "openclaw/openclaw",
      ttl_minutes: "60",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: [
        "warmup",
        "--provider",
        "aws",
        "--desktop",
        "--browser",
        "--ttl",
        "60m",
        "--idle-timeout",
        "30m",
        "--slug",
        "pr-85136-mac",
        "--target",
        "macos",
        "--market",
        "on-demand",
      ],
    });
    expect(commentBody).toContain("Crabbox desktop lease ready for PR testing.");
    expect(commentBody).toContain("- Platform: `mac`");
    expect(commentBody).toContain("- Provider: `aws`");
    expect(commentBody).toContain("Portal: https://crabbox.example.test/portal/leases/cbx_test123");
    expect(commentBody).toContain("WebVNC credentials are intentionally not posted");
    expect(commentBody).not.toContain("/vnc#password=");
  });

  it("finds trusted lease comments from paginated gh slurp output", () => {
    const activeComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_active`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      "Portal: https://crabbox.example.test/portal/leases/cbx_active",
    ].join("\n");

    const { calls, result } = runLeaseScript(
      {
        action: "status",
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [[], [activeComment]],
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: ["inspect", "--provider", "azure", "--target", "linux", "--id", "cbx_active", "--json"],
    });
  });

  it("does not reuse terminal Crabbox lease states", () => {
    const releasedComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_released`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      "Portal: https://crabbox.example.test/portal/leases/cbx_released",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: currentHead,
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [releasedComment],
      { INSPECT_STDOUT: JSON.stringify({ ready: false, state: "released" }) },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: [
        "inspect",
        "--provider",
        "azure",
        "--target",
        "linux",
        "--id",
        "cbx_released",
        "--json",
      ],
    });
    expect(calls).toContainEqual(
      expect.objectContaining({
        tool: "crabbox",
        args: expect.arrayContaining(["warmup", "--provider", "aws"]),
      }),
    );
    expect(commentBody).toContain("- Lease: `cbx_test123`");
    expect(commentBody).not.toContain("already active");
  });

  it("replaces leases when non-zero inspect output reports not found", () => {
    const deletedComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_deleted`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      "Portal: https://crabbox.example.test/portal/leases/cbx_deleted",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: currentHead,
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [deletedComment],
      { INSPECT_STATUS: "6", INSPECT_STDERR: "404 not_found" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual(
      expect.objectContaining({
        tool: "crabbox",
        args: expect.arrayContaining(["warmup", "--provider", "aws"]),
      }),
    );
    expect(commentBody).toContain("- Lease: `cbx_test123`");
  });

  it("does not create a replacement lease when existing lease inspection fails", () => {
    const activeComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_active`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      `- PR code: \`openclaw/openclaw#85136\` at \`${staleHead.slice(0, 12)}\``,
      "Portal: https://crabbox.example.test/portal/leases/cbx_active",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: currentHead,
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [activeComment],
      { INSPECT_STATUS: "6", INSPECT_STDERR: "inspect failed: coordinator unavailable" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls.some((call) => call.tool === "crabbox" && call.args[0] === "warmup")).toBe(false);
    expect(commentBody).toContain("Could not inspect the existing lease");
    expect(commentBody).toContain("inspect failed: coordinator unavailable");
  });

  it("replaces active leases from an older PR head", () => {
    const staleComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_stale`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      `- PR code: \`openclaw/openclaw#85136\` at \`${staleHead.slice(0, 12)}\``,
      "Portal: https://crabbox.example.test/portal/leases/cbx_stale",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: currentHead,
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [staleComment],
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: ["stop", "--provider", "azure", "cbx_stale"],
    });
    expect(calls).toContainEqual(
      expect.objectContaining({
        tool: "crabbox",
        args: expect.arrayContaining(["warmup", "--provider", "aws"]),
      }),
    );
    expect(commentBody).toContain("- Lease: `cbx_test123`");
    expect(commentBody).toContain(currentHead.slice(0, 12));
    expect(commentBody).not.toContain("already active");
  });

  it("restarts WebVNC before reusing an active same-head lease", () => {
    const activeComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_active`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      `- PR code: \`openclaw/openclaw#85136\` at \`${currentHead.slice(0, 12)}\``,
      "Portal: https://crabbox.example.test/portal/leases/cbx_active",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: currentHead,
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [activeComment],
      {
        WEBVNC_STATUS_STDOUTS: JSON.stringify([
          "portal bridge: connected=false viewers=0 observers=0 slots=2",
          "portal bridge: connected=true viewers=0 observers=0 slots=2",
        ]),
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: [
        "webvnc",
        "daemon",
        "start",
        "--provider",
        "azure",
        "--target",
        "linux",
        "--id",
        "cbx_active",
      ],
    });
    expect(calls.some((call) => call.tool === "crabbox" && call.args[0] === "warmup")).toBe(false);
    expect(commentBody).toContain("- Lease: `cbx_active`");
    expect(commentBody).toContain("already active");
  });

  it("comments instead of throwing when same-head WebVNC restart fails", () => {
    const activeComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_active`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      `- PR code: \`openclaw/openclaw#85136\` at \`${currentHead.slice(0, 12)}\``,
      "Portal: https://crabbox.example.test/portal/leases/cbx_active",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: currentHead,
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [activeComment],
      { WEBVNC_STATUS_STDOUT: "portal bridge: connected=false viewers=0 observers=0 slots=2" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: [
        "webvnc",
        "daemon",
        "start",
        "--provider",
        "azure",
        "--target",
        "linux",
        "--id",
        "cbx_active",
      ],
    });
    expect(commentBody).toContain("- Failed step: `reuse-webvnc`");
    expect(commentBody).toContain("portal bridge connected=true");
  });

  it("marks the stale lease stopped before risky replacement warmup", () => {
    const staleComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_stale`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      `- PR code: \`openclaw/openclaw#85136\` at \`${staleHead.slice(0, 12)}\``,
      "Portal: https://crabbox.example.test/portal/leases/cbx_stale",
    ].join("\n");

    const { calls, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: currentHead,
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [staleComment],
      { WARMUP_STATUS: "9" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: ["stop", "--provider", "azure", "cbx_stale"],
    });
    expect(calls).toContainEqual({
      tool: "gh",
      args: [
        "api",
        "--method",
        "PATCH",
        "repos/openclaw/openclaw/issues/comments/1",
        "-F",
        expect.stringMatching(/^body=@/),
      ],
    });
  });

  it("does not create a replacement lease when stopping the stale lease fails", () => {
    const staleComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_stale`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      `- PR code: \`openclaw/openclaw#85136\` at \`${staleHead.slice(0, 12)}\``,
      "Portal: https://crabbox.example.test/portal/leases/cbx_stale",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: currentHead,
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [staleComment],
      { STOP_STATUS: "7" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: ["stop", "--provider", "azure", "cbx_stale"],
    });
    expect(calls.some((call) => call.tool === "crabbox" && call.args[0] === "warmup")).toBe(false);
    expect(commentBody).toContain("could not be stopped before replacement");
    expect(commentBody).toContain("- Lease: `cbx_stale`");
  });

  it("does not post ready until WebVNC reports a connected portal bridge", () => {
    const { commentBody, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: currentHead,
        item_number: "85136",
        platform: "mac",
        provider: "aws",
        target_repo: "openclaw/openclaw",
        ttl_minutes: "60",
      },
      [],
      { WEBVNC_STATUS_STDOUT: "portal bridge: connected=false viewers=0 observers=0 slots=2" },
    );

    expect(result.status).toBe(0);
    expect(commentBody).toContain("did not report portal bridge connected=true");
    expect(commentBody).toContain("- Lease: `cbx_test123`");
    expect(commentBody).not.toContain("desktop lease ready");
  });

  it("redacts standalone WebVNC passwords from readiness failures", () => {
    const { commentBody, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: currentHead,
        item_number: "85136",
        platform: "mac",
        provider: "aws",
        target_repo: "openclaw/openclaw",
        ttl_minutes: "60",
      },
      [],
      {
        WEBVNC_STATUS_STDOUT: [
          "portal bridge: connected=false viewers=0 observers=0 slots=2",
          "webvnc: https://crabbox.example.test/portal/leases/cbx_test123/vnc#password=supersecret",
          "password: supersecret",
        ].join("\n"),
      },
    );

    expect(result.status).toBe(0);
    expect(commentBody).toContain("password: redacted");
    expect(commentBody).not.toContain("supersecret");
    expect(commentBody).not.toContain("#password=");
  });

  it("does not overwrite active lease comments for validation-only failures", () => {
    const activeComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:mac -->",
      "- Platform: `mac`",
      "- Provider: `aws`",
      "- Lease: `cbx_active`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      `- PR code: \`openclaw/openclaw#85136\` at \`${currentHead.slice(0, 12)}\``,
      "Portal: https://crabbox.example.test/portal/leases/cbx_active",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "lease",
        head_sha: staleHead,
        item_number: "85136",
        platform: "mac",
        provider: "aws",
        target_repo: "openclaw/openclaw",
        ttl_minutes: "60",
      },
      [activeComment],
    );

    expect(result.status).toBe(0);
    expect(commentBody).toContain(`PR head changed from ${staleHead} to ${currentHead}`);
    expect(calls).toContainEqual({
      tool: "gh",
      args: [
        "api",
        "repos/openclaw/openclaw/issues/85136/comments",
        "-F",
        expect.stringMatching(/^body=@/),
      ],
    });
    expect(
      calls.some(
        (call) =>
          call.tool === "gh" && call.args.includes("repos/openclaw/openclaw/issues/comments/1"),
      ),
    ).toBe(false);
  });

  it("allows cleanup actions after the PR is closed", () => {
    const activeComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_active`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      `- PR code: \`openclaw/openclaw#85136\` at \`${currentHead.slice(0, 12)}\``,
      "Portal: https://crabbox.example.test/portal/leases/cbx_active",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "stop",
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [activeComment],
      { PR_STATE: "CLOSED" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: ["stop", "--provider", "azure", "cbx_active"],
    });
    expect(commentBody).toContain("Stopped the Crabbox linux desktop lease");
  });

  it("preserves reusable lease metadata when resetting WebVNC", () => {
    const activeComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_active`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      `- PR code: \`openclaw/openclaw#85136\` at \`${currentHead.slice(0, 12)}\``,
      "Portal: https://crabbox.example.test/portal/leases/cbx_active",
    ].join("\n");

    const { commentBody, result } = runLeaseScript(
      {
        action: "reset-vnc",
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
      },
      [activeComment],
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(commentBody).toContain("Reset WebVNC");
    expect(commentBody).toContain("- Expires: `2999-01-01T00:00:00.000Z`");
    expect(commentBody).toContain(currentHead.slice(0, 12));
  });

  it("keeps the workflow alive after resetting the runner-hosted WebVNC bridge", () => {
    const activeComment = [
      "<!-- crabbox-pr-desktop-lease:openclaw/openclaw:85136:linux -->",
      "- Platform: `linux`",
      "- Provider: `azure`",
      "- Lease: `cbx_active`",
      "- Expires: `2999-01-01T00:00:00.000Z`",
      `- PR code: \`openclaw/openclaw#85136\` at \`${currentHead.slice(0, 12)}\``,
      "Portal: https://crabbox.example.test/portal/leases/cbx_active",
    ].join("\n");

    const { calls, commentBody, result } = runLeaseScript(
      {
        action: "reset-vnc",
        item_number: "85136",
        platform: "linux",
        provider: "aws",
        target_repo: "openclaw/openclaw",
        ttl_minutes: "15",
      },
      [activeComment],
      {
        CRABBOX_PR_DESKTOP_LEASE_KEEPALIVE_POLL_MS: "1",
        GITHUB_ACTIONS: "true",
        INSPECT_STDOUTS: JSON.stringify([
          JSON.stringify({ state: "active", status: "running" }),
          JSON.stringify({ state: "stopped", status: "stopped" }),
        ]),
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(commentBody).toContain("Reset WebVNC");
    expect(calls).toContainEqual({
      tool: "crabbox",
      args: [
        "webvnc",
        "reset",
        "--provider",
        "azure",
        "--target",
        "linux",
        "--id",
        "cbx_active",
      ],
    });
    expect(
      calls.filter(
        (call) =>
          call.tool === "crabbox" &&
          call.args[0] === "inspect" &&
          call.args.includes("cbx_active"),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("rejects provider and platform combinations that Crabbox cannot broker", () => {
    const { result } = runLeaseScript({
      action: "lease",
      item_number: "85136",
      platform: "mac",
      provider: "hetzner",
      target_repo: "openclaw/openclaw",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported provider/platform combination");
  });
});
