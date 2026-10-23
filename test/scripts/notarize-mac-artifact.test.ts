import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/notarize-mac-artifact.sh";
const accepted = {
  id: "11111111-2222-4333-8444-555555555555",
  status: "Accepted",
  message: "Apple response",
};
function expectSuccess(result: SpawnSyncReturns<string>) {
  expect(result.status, result.stderr).toBe(0);
  return result;
}
function expectAccepted(file: string) {
  expect(readJson(file)).toEqual(accepted);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
}

function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

it.each([
  ["help", ["--help"], ""],
  ["unknown option", ["--wat"], "Error: unknown notarization option: --wat"],
  ["extra artifact", ["extra"], "Error: unexpected notarization argument: extra"],
  ["missing staple app", [], "Error: STAPLE_APP_PATH not found"],
] as const)("handles %s before notarization", (scenario, options, error) => {
  const root = tempDirs.make("openclaw-notary-input-");
  const artifact = path.join(root, "OpenClaw.zip");
  const missingApp = path.join(root, "Missing.app");
  fs.writeFileSync(artifact, "placeholder", "utf8");
  const result = runScript(
    [
      ...(scenario === "extra artifact" || scenario === "missing staple app" ? [artifact] : []),
      ...options,
    ],
    scenario === "missing staple app" ? { STAPLE_APP_PATH: missingApp } : {},
  );
  expect(result.status).toBe(scenario === "help" ? 0 : 1);
  if (scenario === "help") {
    expect(result.stdout).toContain("Usage: scripts/notarize-mac-artifact.sh <artifact>");
    expect(result.stdout).toContain("NOTARYTOOL_PROFILE");
    expect(result.stderr).toBe("");
  } else if (scenario === "missing staple app") {
    expect(result.stderr).toContain(error);
    expect(result.stderr).not.toContain("xcrun not found");
    expect(result.stderr).not.toContain("Notary auth missing");
    expect(result.stdout).not.toContain("Notarizing:");
  } else {
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(error);
  }
});

it("records the accepted notarization id before stapling", () => {
  const fixture = notarizationFixture();
  const app = path.join(path.dirname(fixture.artifact), "OpenClaw.app");
  fs.mkdirSync(app);
  const result = expectSuccess(fixture.run(false, app));
  expectAccepted(fixture.result);
  expect(result.stdout).toContain(submissionId);
  expect(result.stdout).toContain("Notarization complete");
});

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const submissionId = accepted.id;

function notarizationFixture(extension = "zip", settings: Record<string, unknown> = {}) {
  const root = tempDirs.make("openclaw-notary-resume-");
  const artifact = path.join(root, `OpenClaw.${extension}`);
  const submission = path.join(root, "submission.json");
  const result = path.join(root, "accepted.json");
  const calls = path.join(root, "calls.jsonl");
  const control = path.join(root, "control.json");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(artifact, "signed artifact");
  fs.writeFileSync(control, JSON.stringify(settings));
  const clock = path.join(root, "clock");
  fs.writeFileSync(clock, "0");
  // PATH already isolates external tools; virtual time avoids real retry sleeps.
  for (const [name, body] of Object.entries({
    date: `echo $((1800000000 + $(cat '${clock}')))`,
    sleep: `echo $(($(cat '${clock}') + $1)) > '${clock}'`,
  })) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  fs.writeFileSync(
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
  if (args[1] === "submit") fs.writeFileSync(${JSON.stringify(clock)}, String(Number(fs.readFileSync(${JSON.stringify(clock)}, "utf8")) + (control.submitElapsed || 0)));
  if (args[1] === "submit" && count < (control.submitFailures || 0)) {
    if (control.submitId) console.log(JSON.stringify({id: ${JSON.stringify(submissionId)}}));
    console.error('NSURLErrorDomain -1009 "The Internet connection appears to be offline"');
    process.exit(1);
  }
  if (args[1] === "history") {
    if (count < (control.historyFailures || 0)) { console.error("history transport failure"); process.exit(1); }
    const history = control.history || [];
    if (control.historyMalformed && count === 1) history[0] = {...history[0], createdDate: "not a timestamp"};
    console.log(JSON.stringify({history}));
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
  if (!fs.statSync(args[2]).isDirectory()) fs.appendFileSync(args[2], " stapled ticket");
  if (control.failStage === "staple") process.exit(1);
} else if (args[0] === "stapler" && args[1] === "validate" && control.failStage === "validate") {
  process.exit(1);
}
`,
  );
  fs.chmodSync(path.join(bin, "xcrun"), 0o755);
  return {
    artifact,
    uploadName: `${createHash("sha256").update("signed artifact").digest("hex")}-OpenClaw.${extension}`,
    submission,
    result,
    configure: (value: Record<string, unknown> = {}) =>
      fs.writeFileSync(control, JSON.stringify(value)),
    calls: (method?: string) =>
      fs.existsSync(calls)
        ? fs
            .readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
            .filter((call) => !method || call[1] === method)
        : [],
    run: (withCheckpoint = true, stapleApp = "") =>
      runScript([artifact, ...(withCheckpoint ? ["--submission-file", submission] : [])], {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        NOTARYTOOL_PROFILE: "test-profile",
        NOTARY_RESULT_FILE: result,
        STAPLE_APP_PATH: stapleApp,
        GITHUB_RUN_ID: "35959639128",
        GITHUB_RUN_ATTEMPT: "1",
        APP_VERSION: "2026.9.23",
        BUILD_ARCHS: "arm64",
      }),
  };
}

it.each([["transport"], ["In Progress", "In Progress", "In Progress"], ["malformed", "missing"]])(
  "retries non-terminal wait responses %j on the checkpointed id",
  (...waitResponses) => {
    const fixture = notarizationFixture("zip", { waitResponses });
    const completed = expectSuccess(fixture.run());
    expect(readJson(fixture.submission)).toMatchObject({
      version: 1,
      submissionId,
      result: { id: submissionId, status: "Accepted" },
    });
    expect(fs.statSync(fixture.submission).mode & 0o777).toBe(0o600);
    expect(fixture.calls("submit")).toHaveLength(1);
    const waits = fixture.calls("wait");
    expect(waits).toHaveLength(waitResponses.length + 1);
    expect(waits.every((call) => call[2] === submissionId)).toBe(true);
    expect(completed.stderr).toContain(submissionId);
    expect(completed.stderr).toContain("elapsed");
    expectAccepted(fixture.result);
  },
);

it("exhausts the wait budget with an actionable resume command and resumes the same id", () => {
  const fixture = notarizationFixture("zip", { status: "transport", waitElapsed: 900 });
  const first = fixture.run();
  expect(first.status).toBe(1);
  for (const detail of [
    submissionId,
    "still valid at Apple",
    fixture.submission,
    "gh workflow run openclaw-macos-publish.yml --repo openclaw/releases",
    "-f preflight_only=true",
    "-f tag=v2026.9.23",
    "-f resume_notarization_run_id=35959639128",
    "-f resume_notarization_run_attempt=1",
    "-f resume_notarization_variant=arm64",
  ]) {
    expect(first.stderr).toContain(detail);
  }
  expect(first.stderr).toMatch(/-f source_ref=[0-9a-f]{40}/u);
  expect(fs.existsSync(fixture.result)).toBe(false);
  expect(readJson(fixture.submission)).toMatchObject({ submissionId });
  fixture.configure();
  expectSuccess(fixture.run());
  expect(fixture.calls("submit")).toHaveLength(1);
  expect(fixture.calls("wait")).toHaveLength(3);
});

it.each(["recent matching history", "old", "different name", "failed submit with id"])(
  "recovers submission with %s",
  (scenario) => {
    const fixture = notarizationFixture();
    const matching = scenario === "recent matching history";
    const returnedId = scenario === "failed submit with id";
    const historyEntry = (name: string, age = 0, id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") => ({
      id,
      name,
      createdDate: new Date((1800000000 - age) * 1000).toISOString(),
    });
    const otherEntry = historyEntry(
      matching
        ? `${"a".repeat(64)}-OpenClaw.zip`
        : scenario === "old"
          ? fixture.uploadName
          : "Other.zip",
      scenario === "old" ? 600 : 0,
    );
    fixture.configure({
      submitFailures: 1,
      submitId: returnedId,
      ...(matching ? { submitElapsed: 600, historyFailures: 1, historyMalformed: true } : {}),
      history: [
        ...(matching ? [historyEntry(fixture.uploadName, 1, submissionId)] : []),
        otherEntry,
      ],
    });
    expectSuccess(fixture.run());
    expect(fixture.calls().map((call) => call[1])).toEqual(
      matching
        ? ["submit", "history", "history", "history", "wait"]
        : returnedId
          ? ["submit", "wait"]
          : ["submit", "history", "submit", "wait"],
    );
    expect(readJson(fixture.submission)).toMatchObject({ submissionId });
    if (matching) {
      const uploaded = fixture.calls()[0]?.[2] ?? "";
      expect(path.basename(uploaded)).toBe(fixture.uploadName);
      expect(fs.existsSync(uploaded)).toBe(false);
      expect(fs.readFileSync(fixture.artifact, "utf8")).toBe("signed artifact");
    }
  },
);

it("bounds submit retries when Apple never returns a submission id", () => {
  const fixture = notarizationFixture("zip", { submitFailures: 10 });
  const completed = fixture.run();
  expect(completed.status).toBe(1);
  expect(completed.stderr).toContain("after 5 attempts");
  expect(fixture.calls("submit")).toHaveLength(5);
  expect(fs.existsSync(fixture.submission)).toBe(false);
});

it.each(["changed artifact", "corrupt checkpoint", "wrong artifact name"])(
  "rejects %s before calling Apple",
  (scenario) => {
    const fixture = notarizationFixture();
    expect(fixture.run().status).toBe(0);
    const calls = fixture.calls();
    if (scenario === "changed artifact") {
      fs.writeFileSync(fixture.artifact, "different signed bytes");
    } else if (scenario === "corrupt checkpoint") {
      fs.writeFileSync(fixture.submission, "not JSON");
    } else {
      const checkpoint = readJson(fixture.submission);
      checkpoint.artifactName = "Other.zip";
      fs.writeFileSync(fixture.submission, JSON.stringify(checkpoint));
    }
    const resumed = fixture.run();
    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain("checkpoint");
    expect(fixture.calls()).toEqual(calls);
  },
);

it.each([
  { status: "Rejected", checkpoint: false, calls: ["submit", "log"] },
  { status: "Invalid", checkpoint: true, calls: ["submit", "wait", "log", "log"] },
])(
  "retains $status and its log without publishing accepted output",
  ({ status, checkpoint, calls }) => {
    const fixture = notarizationFixture("zip", { status });
    const rejected = fixture.run(checkpoint);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toContain("The signature is invalid.");
    if (checkpoint) {
      expect(fixture.run().status).not.toBe(0);
    }
    expect(fixture.calls().map((call) => call[1])).toEqual(calls);
    expect(fs.existsSync(fixture.result)).toBe(false);
  },
);

it.each(["staple", "validate"])(
  "preserves and resumes DMG bytes across failure stage %s without resubmitting",
  (failStage) => {
    const fixture = notarizationFixture("dmg");
    fixture.configure({ failStage });
    expect(fixture.run().status).toBe(1);
    expect(fs.readFileSync(fixture.artifact, "utf8")).toBe("signed artifact");
    expect(
      fs
        .readdirSync(path.dirname(fixture.artifact))
        .filter((name) => name.startsWith(".notary-staple") || name.includes(".tmp.")),
    ).toEqual([]);
    fixture.configure();
    expectSuccess(fixture.run());
    expect(fs.readFileSync(fixture.artifact, "utf8")).toBe("signed artifact stapled ticket");
    expectSuccess(fixture.run());
    expect(fixture.calls("submit")).toHaveLength(1);
    expect(fixture.calls("wait")).toHaveLength(1);
    expect(fixture.calls("staple")).toHaveLength(2);
    fs.writeFileSync(fixture.artifact, "tampered after stapling");
    const calls = fixture.calls();
    expect(fixture.run().status).toBe(1);
    expect(fixture.calls()).toEqual(calls);
  },
);

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
  expectSuccess(create);
  fs.writeFileSync(path.join(root, "symbols.zip"), "symbols");
  const run = (command: string, ...args: string[]) =>
    spawnSync("python3", [script, command, root, ...args], { encoding: "utf8" });
  expectSuccess(run("init", sourceSha, version, "202609011", "0", "0"));
  return { root, archive, run, manifest: path.join(root, "manifest.json") };
}

it("seals publication artifacts and retires only after completion while preserving the workflow envelope", () => {
  const fixture = recoveryFixture();
  for (const [name, content] of Object.entries({
    "workflow-release.json": JSON.stringify({ runId: "123" }),
    "sparkle-tools.zip": "signing tools",
    "app-submission.json": JSON.stringify({ submissionId: "apple-id" }),
    "app.dmg": "signed dmg",
    "dmg-submission.json": JSON.stringify({ submissionId: "dmg-id" }),
  })) {
    fs.writeFileSync(path.join(fixture.root, name), content);
  }
  expect(fixture.run("seal").status).toBe(0);
  const verified = expectSuccess(fixture.run("verify", sourceSha, version));
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
  expect(readJson(fixture.manifest)).toEqual(manifest);
  expectSuccess(fixture.run("complete"));
  expect(fixture.run("seal").status).toBe(0);
  const sealed = expectSuccess(fixture.run("verify", sourceSha, version));
  expect(JSON.parse(sealed.stdout).completed).toBe(true);
  expect(fixture.run("retire-completed").status).toBe(0);
  expect(fs.existsSync(fixture.root)).toBe(false);
});

it.each(["incomplete", "changed after completion"])(
  "keeps a checkpoint intact when %s prevents retirement",
  (scenario) => {
    const fixture = recoveryFixture();
    if (scenario !== "incomplete") {
      expect(fixture.run("complete").status).toBe(0);
    }
    const manifest = fs.readFileSync(fixture.manifest, "utf8");
    if (scenario === "incomplete") {
      expect(JSON.parse(manifest).completed).toBe(false);
    } else {
      fs.writeFileSync(fixture.archive, "changed after completion");
    }
    const artifact = fs.readFileSync(fixture.archive);
    const rejected = fixture.run("retire-completed");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      scenario === "incomplete" ? "incomplete" : "SHA-256 mismatch",
    );
    expect(fs.readFileSync(fixture.manifest, "utf8")).toBe(manifest);
    expect(fs.readFileSync(fixture.archive)).toEqual(artifact);
    if (scenario !== "incomplete") {
      expect(fs.readFileSync(fixture.archive, "utf8")).toBe("changed after completion");
    }
  },
);

it.each([
  "artifact tamper",
  "source mismatch",
  "version mismatch",
  "manifest symlink",
  "traversal",
  "escaping-link",
])("rejects %s before restoring artifacts", (scenario) => {
  const unsafeArchive = scenario === "traversal" || scenario === "escaping-link";
  const fixture = recoveryFixture(unsafeArchive ? scenario : "valid");
  let source = sourceSha;
  let releaseVersion = version;
  if (scenario === "artifact tamper") {
    fs.writeFileSync(fixture.archive, "different artifact");
  } else if (scenario === "source mismatch") {
    source = "b".repeat(40);
  } else if (scenario === "version mismatch") {
    releaseVersion = "2026.8.3";
  } else if (scenario === "manifest symlink") {
    const link = path.join(fixture.root, "manifest-link.json");
    fs.symlinkSync(fixture.manifest, link);
    fs.renameSync(link, fixture.manifest);
  }
  const rejected = fixture.run("verify", source, releaseVersion);
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain("macOS notarization recovery:");
  if (unsafeArchive) {
    expect(rejected.stderr).toMatch(/unsafe path|symlink escapes/u);
  }
  expect(rejected.stdout).toBe("");
});
