import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/notarize-mac-artifact.sh";

describe("notarize-mac-artifact input validation", () => {
  it("prints help without checking artifact or notary tools", () => {
    const result = spawnSync("/bin/bash", [scriptPath, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: scripts/notarize-mac-artifact.sh <artifact>");
    expect(result.stdout).toContain("NOTARYTOOL_PROFILE");
    expect(result.stderr).toBe("");
  });

  it("rejects unknown options before artifact validation", () => {
    const result = spawnSync("/bin/bash", [scriptPath, "--wat"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Error: unknown notarization option: --wat");
  });

  it("rejects extra artifact arguments before notarization", () => {
    const tempRoot = tempDirs.make("openclaw-notary-extra-");
    const artifact = path.join(tempRoot, "OpenClaw.zip");
    writeFileSync(artifact, "placeholder", "utf8");

    const result = spawnSync("/bin/bash", [scriptPath, artifact, "extra"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Error: unexpected notarization argument: extra");
  });

  it("fails before notarization when an explicit staple app path is missing", () => {
    const tempRoot = tempDirs.make("openclaw-notary-staple-");
    const artifact = path.join(tempRoot, "OpenClaw.zip");
    const missingApp = path.join(tempRoot, "Missing.app");
    writeFileSync(artifact, "placeholder", "utf8");

    const result = spawnSync("/bin/bash", [scriptPath, artifact], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        STAPLE_APP_PATH: missingApp,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error: STAPLE_APP_PATH not found");
    expect(result.stderr).not.toContain("xcrun not found");
    expect(result.stderr).not.toContain("Notary auth missing");
    expect(result.stdout).not.toContain("Notarizing:");
  });

  it("records the accepted notarization id before stapling", () => {
    const tempRoot = tempDirs.make("openclaw-notary-result-");
    const artifact = path.join(tempRoot, "OpenClaw.zip");
    const app = path.join(tempRoot, "OpenClaw.app");
    const binDir = path.join(tempRoot, "bin");
    const resultPath = path.join(tempRoot, "notary-result.json");
    const accepted = {
      id: "11111111-2222-3333-4444-555555555555",
      status: "Accepted",
      message: "Processing complete",
    };
    writeFileSync(artifact, "placeholder", "utf8");
    mkdirSync(app);
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "xcrun"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "${1:-}" == "notarytool" ]]; then',
        `  printf '%s\\n' '${JSON.stringify(accepted)}'`,
        "  exit 0",
        "fi",
        '[[ "${1:-}" == "stapler" ]]',
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(binDir, "xcrun"), 0o755);

    const result = spawnSync("/bin/bash", [scriptPath, artifact], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NOTARYTOOL_PROFILE: "test-profile",
        NOTARY_RESULT_FILE: resultPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        STAPLE_APP_PATH: app,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual(accepted);
    expect(statSync(resultPath).mode & 0o777).toBe(0o600);
    expect(result.stdout).toContain(accepted.id);
    expect(result.stdout).toContain("Notarization complete");
  });
});

const submissionId = "11111111-2222-4333-8444-555555555555";

function notarizationFixture(extension = "zip") {
  const root = tempDirs.make("openclaw-notary-resume-");
  const artifact = path.join(root, `OpenClaw.${extension}`);
  const submission = path.join(root, "submission.json");
  const result = path.join(root, "accepted.json");
  const calls = path.join(root, "calls.jsonl");
  const control = path.join(root, "control.json");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(artifact, "signed artifact");
  writeFileSync(control, "{}");
  const clock = path.join(root, "clock");
  writeFileSync(clock, "0");
  // PATH already isolates external tools; virtual time avoids real retry sleeps.
  for (const [name, body] of Object.entries({
    date: `echo $((1800000000 + $(cat '${clock}')))`,
    sleep: `echo $(($(cat '${clock}') + $1)) > '${clock}'`,
  })) {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  writeFileSync(
    path.join(bin, "xcrun"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = ${JSON.stringify(calls)};
const prior = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\\n").map(JSON.parse) : [];
fs.appendFileSync(calls, JSON.stringify(args) + "\\n");
const control = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, "utf8"));
if (args[0] === "notarytool") {
  const count = prior.filter(call => call[1] === args[1]).length;
  if (args[1] === "submit" && count < (control.submitFailures || 0)) {
    if (control.submitId) console.log(JSON.stringify({id: ${JSON.stringify(submissionId)}}));
    console.error('NSURLErrorDomain -1009 "The Internet connection appears to be offline"');
    process.exit(1);
  }
  if (args[1] === "history") {
    console.log(JSON.stringify({history: control.history || []}));
    process.exit(0);
  }
  if (args[1] === "log") {
    console.log(JSON.stringify({issues: [{message: "The signature is invalid."}]}));
    process.exit(0);
  }
  let status = control.status || "Accepted";
  if (args[1] === "wait") {
    fs.writeFileSync(${JSON.stringify(clock)}, String(Number(fs.readFileSync(${JSON.stringify(clock)}, "utf8")) + (control.waitElapsed || 0)));
    status = control.waitResponses?.[count] || status;
    if (status === "transport") {
      console.error('NSURLErrorDomain -1009 "The Internet connection appears to be offline"');
      process.exit(1);
    }
    if (status === "malformed") { console.log("not JSON"); process.exit(0); }
    if (status === "missing") { console.log(JSON.stringify({id: ${JSON.stringify(submissionId)}})); process.exit(0); }
  }
  console.log(JSON.stringify({id: ${JSON.stringify(submissionId)}, status: args.includes("--no-wait") ? "In Progress" : status, message: "Apple response"}));
  if ((args[1] === "wait" || args.includes("--wait")) && (status === "Invalid" || status === "Rejected")) process.exit(65);
} else if (args[0] === "stapler" && args[1] === "staple") {
  fs.appendFileSync(args[2], " stapled ticket");
  if (control.failStage === "staple") process.exit(1);
} else if (args[0] === "stapler" && args[1] === "validate" && control.failStage === "validate") {
  process.exit(1);
}
`,
  );
  chmodSync(path.join(bin, "xcrun"), 0o755);
  return {
    artifact,
    uploadName: `${createHash("sha256").update("signed artifact").digest("hex")}-OpenClaw.${extension}`,
    submission,
    result,
    control,
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [],
    run: (withCheckpoint = true) =>
      spawnSync(
        "/bin/bash",
        [scriptPath, artifact, ...(withCheckpoint ? ["--submission-file", submission] : [])],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            NOTARYTOOL_PROFILE: "test-profile",
            NOTARY_RESULT_FILE: result,
            STAPLE_APP_PATH: "",
            GITHUB_RUN_ID: "35959639128",
            GITHUB_RUN_ATTEMPT: "1",
            APP_VERSION: "2026.9.23",
            BUILD_ARCHS: "arm64",
          },
        },
      ),
  };
}

describe("notarization submission recovery", () => {
  it.each([["transport"], ["In Progress", "In Progress", "In Progress"], ["malformed", "missing"]])(
    "retries non-terminal wait responses %j on the checkpointed id",
    (...waitResponses) => {
      const fixture = notarizationFixture();
      writeFileSync(fixture.control, JSON.stringify({ waitResponses }));
      const completed = fixture.run();
      expect(completed.status, completed.stderr).toBe(0);
      expect(JSON.parse(readFileSync(fixture.submission, "utf8"))).toMatchObject({
        version: 1,
        submissionId,
        result: { id: submissionId, status: "Accepted" },
      });
      expect(statSync(fixture.submission).mode & 0o777).toBe(0o600);
      expect(fixture.calls().filter((call) => call[1] === "submit")).toHaveLength(1);
      const waits = fixture.calls().filter((call) => call[1] === "wait");
      expect(waits).toHaveLength(waitResponses.length + 1);
      expect(waits.every((call) => call[2] === submissionId)).toBe(true);
      expect(completed.stderr).toContain(submissionId);
      expect(completed.stderr).toContain("elapsed");
      expect(JSON.parse(readFileSync(fixture.result, "utf8"))).toEqual({
        id: submissionId,
        status: "Accepted",
        message: "Apple response",
      });
      expect(statSync(fixture.result).mode & 0o777).toBe(0o600);
    },
  );

  it("exhausts the wait budget with an actionable resume command and resumes the same id", () => {
    const fixture = notarizationFixture();
    writeFileSync(fixture.control, JSON.stringify({ status: "transport", waitElapsed: 900 }));
    const first = fixture.run();
    expect(first.status).toBe(1);
    expect(first.stderr).toContain(submissionId);
    expect(first.stderr).toContain("still valid at Apple");
    expect(first.stderr).toContain(fixture.submission);
    expect(first.stderr).toContain(
      "gh workflow run openclaw-macos-publish.yml --repo openclaw/releases",
    );
    expect(first.stderr).toContain("-f preflight_only=true");
    expect(first.stderr).toContain("-f tag=v2026.9.23");
    expect(first.stderr).toMatch(/-f source_ref=[0-9a-f]{40}/u);
    expect(first.stderr).toContain("-f resume_notarization_run_id=35959639128");
    expect(first.stderr).toContain("-f resume_notarization_run_attempt=1");
    expect(first.stderr).toContain("-f resume_notarization_variant=arm64");
    expect(existsSync(fixture.result)).toBe(false);
    expect(JSON.parse(readFileSync(fixture.submission, "utf8"))).toMatchObject({ submissionId });
    writeFileSync(fixture.control, "{}");
    const resumed = fixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(fixture.calls().filter((call) => call[1] === "submit")).toHaveLength(1);
    expect(fixture.calls().filter((call) => call[1] === "wait")).toHaveLength(3);
  });

  it("adopts a recent matching history entry after losing the submit response", () => {
    const fixture = notarizationFixture();
    writeFileSync(
      fixture.control,
      JSON.stringify({
        submitFailures: 1,
        history: [
          {
            id: submissionId,
            name: fixture.uploadName,
            createdDate: new Date(1799999999000).toISOString(),
          },
          {
            id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            name: `${"a".repeat(64)}-OpenClaw.zip`,
            createdDate: new Date(1800000000000).toISOString(),
          },
        ],
      }),
    );
    const completed = fixture.run();
    expect(completed.status, completed.stderr).toBe(0);
    expect(fixture.calls().map((call) => call[1])).toEqual(["submit", "history", "wait"]);
    expect(JSON.parse(readFileSync(fixture.submission, "utf8"))).toMatchObject({ submissionId });
    const uploaded = fixture.calls()[0]?.[2] ?? "";
    expect(path.basename(uploaded)).toBe(fixture.uploadName);
    expect(existsSync(uploaded)).toBe(false);
    expect(readFileSync(fixture.artifact, "utf8")).toBe("signed artifact");
  });

  it.each(["empty", "old", "different name"])(
    "retries submit when history is %s",
    (historyCase) => {
      const fixture = notarizationFixture();
      writeFileSync(
        fixture.control,
        JSON.stringify({
          submitFailures: 1,
          history:
            historyCase === "empty"
              ? []
              : [
                  {
                    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                    name: historyCase === "old" ? fixture.uploadName : "Other.zip",
                    createdDate: new Date(
                      (1800000000 - (historyCase === "old" ? 600 : 0)) * 1000,
                    ).toISOString(),
                  },
                ],
        }),
      );
      const completed = fixture.run();
      expect(completed.status, completed.stderr).toBe(0);
      expect(fixture.calls().map((call) => call[1])).toEqual([
        "submit",
        "history",
        "submit",
        "wait",
      ]);
      expect(JSON.parse(readFileSync(fixture.submission, "utf8"))).toMatchObject({ submissionId });
    },
  );

  it("persists an id even when submit exits unsuccessfully", () => {
    const fixture = notarizationFixture();
    writeFileSync(fixture.control, JSON.stringify({ submitFailures: 1, submitId: true }));
    const completed = fixture.run();
    expect(completed.status, completed.stderr).toBe(0);
    expect(fixture.calls().map((call) => call[1])).toEqual(["submit", "wait"]);
    expect(JSON.parse(readFileSync(fixture.submission, "utf8"))).toMatchObject({ submissionId });
  });

  it("bounds submit retries when Apple never returns a submission id", () => {
    const fixture = notarizationFixture();
    writeFileSync(fixture.control, JSON.stringify({ submitFailures: 10 }));
    const completed = fixture.run();
    expect(completed.status).toBe(1);
    expect(completed.stderr).toContain("after 5 attempts");
    expect(fixture.calls().filter((call) => call[1] === "submit")).toHaveLength(5);
    expect(existsSync(fixture.submission)).toBe(false);
  });

  it.each(["changed artifact", "corrupt checkpoint", "wrong artifact name"])(
    "rejects %s before calling Apple",
    (scenario) => {
      const fixture = notarizationFixture();
      expect(fixture.run().status).toBe(0);
      const calls = fixture.calls();
      if (scenario === "changed artifact") {
        writeFileSync(fixture.artifact, "different signed bytes");
      } else if (scenario === "corrupt checkpoint") {
        writeFileSync(fixture.submission, "not JSON");
      } else {
        const checkpoint = JSON.parse(readFileSync(fixture.submission, "utf8"));
        checkpoint.artifactName = "Other.zip";
        writeFileSync(fixture.submission, JSON.stringify(checkpoint));
      }
      const resumed = fixture.run();
      expect(resumed.status).toBe(1);
      expect(resumed.stderr).toContain("checkpoint");
      expect(fixture.calls()).toEqual(calls);
    },
  );

  it("prints the notary log on a standalone terminal rejection", () => {
    const fixture = notarizationFixture();
    writeFileSync(fixture.control, JSON.stringify({ status: "Rejected" }));
    const rejected = fixture.run(false);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toContain("The signature is invalid.");
    expect(fixture.calls().map((call) => call[1])).toEqual(["submit", "log"]);
    expect(existsSync(fixture.result)).toBe(false);
  });

  it("retains Apple's terminal rejection without publishing accepted output or resubmitting", () => {
    const fixture = notarizationFixture();
    writeFileSync(fixture.control, JSON.stringify({ status: "Invalid" }));
    const rejected = fixture.run();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toContain("The signature is invalid.");
    expect(fixture.run().status).not.toBe(0);
    expect(fixture.calls().map((call) => call[1])).toEqual(["submit", "wait", "log", "log"]);
    expect(existsSync(fixture.result)).toBe(false);
  });

  it.each(["staple", "validate"])(
    "preserves original DMG bytes when %s fails and resumes without a second submission",
    (failStage) => {
      const fixture = notarizationFixture("dmg");
      writeFileSync(fixture.control, JSON.stringify({ failStage }));
      expect(fixture.run().status).toBe(1);
      expect(readFileSync(fixture.artifact, "utf8")).toBe("signed artifact");
      expect(
        readdirSync(path.dirname(fixture.artifact)).filter(
          (name) => name.startsWith(".notary-staple") || name.includes(".tmp."),
        ),
      ).toEqual([]);
      writeFileSync(fixture.control, "{}");
      const resumed = fixture.run();
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(fixture.calls().filter((call) => call[1] === "submit")).toHaveLength(1);
      expect(fixture.calls().filter((call) => call[1] === "wait")).toHaveLength(1);
      expect(readFileSync(fixture.artifact, "utf8")).toBe("signed artifact stapled ticket");
    },
  );

  it("recognizes the stapled DMG on a repeated invocation without uploading its changed bytes", () => {
    const fixture = notarizationFixture("dmg");
    writeFileSync(fixture.control, "{}");
    const first = fixture.run();
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(fixture.artifact, "utf8")).toBe("signed artifact stapled ticket");
    const resumed = fixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(fixture.calls().filter((call) => call[1] === "submit")).toHaveLength(1);
    expect(fixture.calls().filter((call) => call[1] === "wait")).toHaveLength(1);
    expect(fixture.calls().filter((call) => call[1] === "staple")).toHaveLength(1);
    writeFileSync(fixture.artifact, "tampered after stapling");
    const calls = fixture.calls();
    expect(fixture.run().status).toBe(1);
    expect(fixture.calls()).toEqual(calls);
  });
});

const script = "scripts/lib/mac-notarization-recovery.py";
const sourceSha = "a".repeat(40);
const version = "2026.8.2";

function recoveryFixture(archiveCase = "valid") {
  const root = tempDirs.make("mac-notary-checkpoint-");
  const archive = path.join(root, "app.zip");
  const create = spawnSync(
    "python3",
    [
      "-c",
      `
import stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("OpenClaw.app/Contents/Info.plist", "signed bundle metadata")
    if sys.argv[2] == "traversal":
        archive.writestr("OpenClaw.app/../../outside", "escape")
    if sys.argv[2] in ("escaping-link", "valid"):
        entry = zipfile.ZipInfo("OpenClaw.app/Contents/Frameworks/Current")
        entry.create_system = 3
        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(entry, "../../../outside" if sys.argv[2] == "escaping-link" else "VersionA")
`,
      archive,
      archiveCase,
    ],
    { encoding: "utf8" },
  );
  expect(create.status, create.stderr).toBe(0);
  writeFileSync(path.join(root, "symbols.zip"), "symbols");
  const run = (command: string, ...args: string[]) =>
    spawnSync("python3", [script, command, root, ...args], { encoding: "utf8" });
  const initialized = run("init", sourceSha, version, "202609011", "0", "0");
  expect(initialized.status, initialized.stderr).toBe(0);
  return { root, archive, run, manifest: path.join(root, "manifest.json") };
}

describe("retained macOS notarization artifacts", () => {
  it("seals updated publication artifacts while allowing the separate workflow envelope", () => {
    const fixture = recoveryFixture();
    writeFileSync(
      path.join(fixture.root, "workflow-release.json"),
      JSON.stringify({ runId: "123" }),
    );
    writeFileSync(path.join(fixture.root, "sparkle-tools.zip"), "signing tools");
    writeFileSync(
      path.join(fixture.root, "app-submission.json"),
      JSON.stringify({ submissionId: "apple-id" }),
    );
    writeFileSync(path.join(fixture.root, "app.dmg"), "signed dmg");
    writeFileSync(
      path.join(fixture.root, "dmg-submission.json"),
      JSON.stringify({ submissionId: "dmg-id" }),
    );
    expect(fixture.run("seal").status).toBe(0);
    const verified = fixture.run("verify", sourceSha, version);
    expect(verified.status, verified.stderr).toBe(0);
    const manifest = JSON.parse(verified.stdout);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      sourceSha,
      version,
      build: "202609011",
      skipDmg: false,
      skipDsym: false,
    });
    expect(Object.keys(manifest.files).toSorted()).toEqual([
      "app-submission.json",
      "app.dmg",
      "app.zip",
      "dmg-submission.json",
      "sparkle-tools.zip",
      "symbols.zip",
    ]);
    expect(manifest.files["sparkle-tools.zip"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(readFileSync(fixture.manifest, "utf8"))).toEqual(manifest);
  });

  it("keeps incomplete checkpoints intact until terminal packaging success", () => {
    const fixture = recoveryFixture();
    const manifest = readFileSync(fixture.manifest, "utf8");
    const artifact = readFileSync(fixture.archive);
    expect(JSON.parse(manifest).completed).toBe(false);
    const rejected = fixture.run("retire-completed");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("incomplete");
    expect(readFileSync(fixture.manifest, "utf8")).toBe(manifest);
    expect(readFileSync(fixture.archive)).toEqual(artifact);
  });

  it("retains completion through seal and verify, then retires only the completed checkpoint", () => {
    const fixture = recoveryFixture();
    writeFileSync(path.join(fixture.root, "workflow-release.json"), "{}");
    writeFileSync(path.join(fixture.root, "app.dmg"), "notarized dmg");
    const completed = fixture.run("complete");
    expect(completed.status, completed.stderr).toBe(0);
    expect(fixture.run("seal").status).toBe(0);
    const verified = fixture.run("verify", sourceSha, version);
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout).completed).toBe(true);
    expect(fixture.run("retire-completed").status).toBe(0);
    expect(existsSync(fixture.root)).toBe(false);
  });

  it("refuses to retire a completed checkpoint whose artifact bytes changed", () => {
    const fixture = recoveryFixture();
    expect(fixture.run("complete").status).toBe(0);
    const manifest = readFileSync(fixture.manifest, "utf8");
    writeFileSync(fixture.archive, "changed after completion");
    const rejected = fixture.run("retire-completed");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("SHA-256 mismatch");
    expect(readFileSync(fixture.manifest, "utf8")).toBe(manifest);
    expect(readFileSync(fixture.archive, "utf8")).toBe("changed after completion");
  });

  it.each(["artifact tamper", "source mismatch", "version mismatch", "manifest symlink"])(
    "rejects %s before restoring artifacts",
    (scenario) => {
      const fixture = recoveryFixture();
      let source = sourceSha;
      let releaseVersion = version;
      if (scenario === "artifact tamper") {
        writeFileSync(fixture.archive, "different artifact");
      } else if (scenario === "source mismatch") {
        source = "b".repeat(40);
      } else if (scenario === "version mismatch") {
        releaseVersion = "2026.8.3";
      } else {
        const link = path.join(fixture.root, "manifest-link.json");
        symlinkSync(fixture.manifest, link);
        renameSync(link, fixture.manifest);
      }
      const rejected = fixture.run("verify", source, releaseVersion);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("macOS notarization recovery:");
      expect(rejected.stdout).toBe("");
    },
  );

  it.each(["traversal", "escaping-link"])("rejects a sealed app archive with %s", (archiveCase) => {
    const fixture = recoveryFixture(archiveCase);
    const rejected = fixture.run("verify", sourceSha, version);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/unsafe path|symlink escapes/u);
    expect(rejected.stdout).toBe("");
  });
});
