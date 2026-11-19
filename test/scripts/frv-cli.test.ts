import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  child,
  executionPlanArtifact,
  job,
  rootRun,
  runFor,
  TARGET_SHA,
} from "./frv.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("frv CLI", () => {
  // This fixture executes a POSIX shebang shim; Windows does not support that executable format.
  it.skipIf(process.platform === "win32").each(["success", "failure"])(
    "reports target %s but exits 1 when an untouched job remains red",
    (conclusion) => {
      const directory = tempDirs.make("frv-rerun-cli-");
      const selected = child("normalCi", "101");
      const workflow = "name: Full Release Validation\n";
      const sourcePath = ".github/workflows/full-release-validation.yml";
      const fixture = {
        plan: executionPlanArtifact({ children: [selected] }),
        parent: rootRun(),
        runs: [runFor(selected, 1, "failure"), runFor(selected, 2, "failure")],
        jobs: [
          ["selected", "untouched"].map((name, index) =>
            Object.assign(job(name, "failure"), { id: 10 + index, run_id: 101, run_attempt: 1 }),
          ),
          [{ ...job("selected", conclusion), id: 20, run_id: 101, run_attempt: 2 }],
        ],
        workflow: {
          type: "file",
          path: sourcePath,
          encoding: "base64",
          size: Buffer.byteLength(workflow),
          content: Buffer.from(workflow).toString("base64"),
          sha: createHash("sha1")
            .update(`blob ${Buffer.byteLength(workflow)}\0${workflow}`)
            .digest("hex"),
        },
      };
      writeFileSync(resolve(directory, "fixture.json"), JSON.stringify(fixture));
      const gh = resolve(directory, "gh");
      writeFileSync(
        gh,
        String.raw`#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync("fixture.json", "utf8"));
const sent = fs.existsSync("rerun.json");
const route = args.find(arg => arg.startsWith("repos/"))?.replace("repos/openclaw/openclaw/", "");
let value;
if (args[0] === "run" && args[1] === "download" && args[2] === "77") {
  fs.writeFileSync(path.join(args[args.indexOf("--dir") + 1], "full-release-execution-plan.json"), JSON.stringify(fixture.plan));
  process.exit(0);
} else if (args.includes("POST") && route === "actions/jobs/10/rerun" && !sent) {
  fs.writeFileSync("rerun.json", JSON.stringify(args));
  process.exit(0);
} else if (args.includes("POST")) {
  throw new Error("unexpected mutation: " + JSON.stringify(args));
} else if (route === "actions/runs/77" || route === "actions/runs/77/attempts/1") {
  value = fixture.parent;
} else if (route === "actions/runs/101") {
  value = fixture.runs[sent ? 1 : 0];
} else if (route === "actions/runs/101/attempts/1") {
  value = fixture.runs[0];
} else if (route === "actions/runs/77/jobs?filter=all&per_page=100") {
  value = [{ id: 1, name: "Resolve target ref", status: "completed", conclusion: "success", run_attempt: 1 },
    { id: 2, name: "Run normal full CI", status: "completed", conclusion: "failure", run_attempt: 1 }];
} else if (route === "actions/jobs/1/logs") {
  process.stdout.write("RERUN_GROUP: all\nFAIL_FAST: false\nTARGET_SHA: ${TARGET_SHA}\n");
  process.exit(0);
} else if (route === "actions/jobs/2/logs") {
  process.stdout.write("TARGET_SHA: ${TARGET_SHA}\nDispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/101 (attempt 1)\n");
  process.exit(0);
} else if (route?.startsWith("contents/")) {
  value = fixture.workflow;
} else if (/^actions\/runs\/101\/attempts\/[12]\/jobs\?per_page=100$/.test(route ?? "")) {
  value = fixture.jobs[route.includes("/attempts/2/") ? 1 : 0];
} else {
  throw new Error("unexpected read: " + JSON.stringify(args));
}
process.stdout.write(Array.isArray(value) ? value.map(job => JSON.stringify(job)).join("\n") : JSON.stringify(value));
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/frv.mjs"), "rerun", "--run", "77", "--job", "normalCi:selected"],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 15_000,
          env: {
            HOME: directory,
            TMPDIR: directory,
            PATH: directory,
            OPENCLAW_GH_BIN: gh,
            GH_TOKEN: "synthetic-fixture-token",
          },
        },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        `[frv] target normalCi:selected: ${conclusion} (accepted attempt 2)`,
      );
      expect(result.stderr).toContain("[frv] composite normalCi: failed (attempt 2)");
      expect(result.stderr).toContain("[frv] FAILED (exit 1)");
      expect(result.stdout).toBe("");
      expect(JSON.parse(readFileSync(resolve(directory, "rerun.json"), "utf8"))).toEqual([
        "api",
        "-X",
        "POST",
        "repos/openclaw/openclaw/actions/jobs/10/rerun",
      ]);
    },
  );

  it.each(["--help", "-h", "help"])("prints help successfully for %s", (argument) => {
    const result = spawnSync(process.execPath, [resolve("scripts/frv.mjs"), argument], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: pnpm frv");
    expect(result.stdout).toContain("--no-follow");
  });

  it.each([
    ["--run", "77", "--workflow-sha", "a".repeat(40), "--request-file", "unused-request.json"],
    ["--reconcile-request", "unused-request.json"],
  ])("rejects retired receipt recovery before transport for %j", (...arguments_) => {
    const preload = `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const rejectTransport = () => {
        process.stdout.write("unexpected transport");
        throw new Error("unexpected transport");
      };
      childProcess.spawn = rejectTransport;
      childProcess.execFileSync = rejectTransport;
      childProcess.execFile = rejectTransport;
      globalThis.fetch = rejectTransport;
      syncBuiltinESMExports();
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        resolve("scripts/frv.mjs"),
        "recover",
        ...arguments_,
      ],
      { encoding: "utf8", env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" } },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[frv] recover is retired");
    expect(result.stderr).toContain("fresh qualification with pnpm ci:full-release");
    expect(result.stdout).toBe("");
  });

  it.each([
    ["status", "--no-follow is valid only with rerun --job"],
    ["rerun", "--no-follow is valid only with rerun --job", "--child", "normalCi"],
  ])("rejects --no-follow for unsupported %s commands", (command, message, ...arguments_) => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/frv.mjs"), command, "--run", "77", ...arguments_, "--no-follow"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`[frv] ${message}`);
  });
});
