import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { publishInstalledTerminalDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { writeInstalledRecoveryEvidence } from "../../scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs";
import {
  buildInstalledTerminalSummary,
  publishInstalledTerminalEvidence,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-terminal-observer.mjs";
import { redactSensitiveText } from "../../src/logging/redact.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copySurvivorCaptureClosure } from "../helpers/upgrade-survivor-diagnostics.js";
import { readJson, writeJson } from "./upgrade-survivor-shard.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const packageSha256 = "a".repeat(64);
const cells = ["healthy", "late-failure", "historical-control"];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// Exercise the real bounded exporter and host publisher. These small records
// qualify publication, not the installed-process runtime oracle.
function fixture(stage: "checkpoint" | "manifest" | "complete" = "complete") {
  const root = fs.realpathSync(dirs.make("installed-terminal-publication-"));
  const raw = path.join(root, "private");
  const destination = path.join(root, "uploads");
  fs.mkdirSync(raw);
  const identity = {
    version: "2026.11.21-first-hop.1",
    buildInfo: { version: "2026.11.21-first-hop.1", commit: "b".repeat(40) },
    files: { "dist/entry.js": { size: 1, sha256: "c".repeat(64) } },
  };
  for (const [name, value] of Object.entries({
    "candidate-package-identity.json": identity,
    "package-hasher-contract.json": {},
    "package-heartbeat-contracts.json": {},
    "installed-terminal-contracts.json": {
      packageSha256,
      application: {
        metadata: { version: "2026.11.20", build: { commit: identity.buildInfo.commit } },
      },
    },
  })) {
    writeJson(path.join(raw, name), value);
  }
  const summary = {
    status: "passed",
    scope: "installed-terminal-package-settlement",
    sourcePackageSha256: packageSha256,
    candidateSha256: "d".repeat(64),
    fixture: {
      method: "candidate-same-schema-first-hop-fixture",
      sourceSha256: packageSha256,
      targetSha256: "d".repeat(64),
      sourceVersion: "2026.11.20",
      targetVersion: identity.version,
    },
    unjoined: false,
    runtimeRemoved: true,
    commands: cells.map((name, index) => ({
      name: `${name}-update`,
      status: "completed",
      treeJoined: true,
      exitCode: index === 0 ? 0 : 1,
      exit: { code: index === 0 ? 0 : 1, signal: null },
      outputComplete: true,
      outputEnded: [true, true],
      outputBytes: [14, 0],
      capturedOutputBytes: [14, 0],
      outputSha256: [hash(Buffer.from("joined update\n")), hash(Buffer.alloc(0))],
    })),
    cells: cells.map((name) => ({
      name,
      status: "passed",
      cleanup: {
        status: "complete",
        joined: true,
        phase: "anchor-retired",
        activeInstallLeases: 0,
        journalRetained: true,
      },
      installedIdentity: {
        version: identity.version,
        buildInfo: identity.buildInfo,
        files: 1,
      },
    })),
  };
  writeJson(path.join(raw, "installed-terminal.json"), summary);
  for (const name of cells) {
    fs.writeFileSync(path.join(raw, `${name}-update.out`), "joined update\n");
    fs.writeFileSync(path.join(raw, `${name}-update.err`), "");
    fs.mkdirSync(path.join(raw, name));
    writeJson(path.join(raw, `${name}-dependencies.json`), {});
    fs.writeFileSync(
      path.join(raw, name, "1-0.jsonl"),
      ["startup", "handoff", "exit"]
        .map(
          (event, sequence) =>
            JSON.stringify({
              pid: 1,
              thread: 0,
              sequence,
              time: String(sequence + 1),
              event,
            }) + "\n",
        )
        .join(""),
    );
  }
  if (stage !== "checkpoint") {
    publishInstalledTerminalEvidence(raw, summary);
  }
  const exported = path.join(raw, "export");
  const finish = (value = summary) =>
    writeJson(
      path.join(exported, "installed-terminal.json"),
      buildInstalledTerminalSummary(
        value,
        fs.readFileSync(path.join(exported, "manifest.json")),
        (name) => fs.readFileSync(path.join(exported, name)),
      ),
    );
  if (stage === "complete") {
    finish();
  }
  return { root, raw, destination, exported, summary, finish };
}

function publish(f: ReturnType<typeof fixture>, exitStatus = 0, timedOut = false) {
  return publishInstalledTerminalDiagnostics(f.raw, f.destination, redactSensitiveText, {
    exitStatus,
    timedOut,
    packageSha256,
  });
}

function expectPublicProjection(f: ReturnType<typeof fixture>) {
  const manifest = readJson(path.join(f.destination, "manifest.json"));
  const privateManifest = fs.readFileSync(path.join(f.exported, "manifest.json"));
  expect(manifest.qualification).toBe("redacted-diagnostic-projection");
  expect(manifest.privateArtifact).toEqual({
    bytes: privateManifest.length,
    sha256: hash(privateManifest),
  });
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(f.destination, entry.name));
    const original = fs.readFileSync(path.join(f.exported, entry.name));
    expect({ bytes: bytes.length, sha256: hash(bytes) }).toEqual({
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
    expect(entry.privateArtifact).toEqual({ bytes: original.length, sha256: hash(original) });
  }
  const final = readJson(path.join(f.destination, "installed-terminal.json"));
  expect(final.privateEvidence).toEqual(
    readJson(path.join(f.exported, "installed-terminal.json")).evidence,
  );
  expect(final.evidence.sha256).toBe(
    hash(fs.readFileSync(path.join(f.destination, "manifest.json"))),
  );
}

it("publishes a near-cap native manifest with complete compact provenance", async () => {
  const f = fixture("checkpoint");
  for (const name of cells) {
    for (let index = 0; index < 221; index++) {
      const pid = 1_000_000_000 + index;
      fs.writeFileSync(
        path.join(f.raw, name, `${pid}-0.jsonl`),
        ["startup", "exit"]
          .map(
            (event, sequence) =>
              JSON.stringify({ pid, thread: 0, sequence, time: String(sequence + 1), event }) +
              "\n",
          )
          .join(""),
      );
    }
  }
  publishInstalledTerminalEvidence(f.raw, f.summary);
  f.finish();
  const privateBytes = fs.readFileSync(path.join(f.exported, "manifest.json"));
  expect(privateBytes.length).toBeGreaterThan(128_000);
  expect(privateBytes.length).toBeLessThanOrEqual(128 * 1024);
  await publish(f);
  const publicBytes = fs.readFileSync(path.join(f.destination, "manifest.json"));
  const manifest = JSON.parse(publicBytes.toString());
  // The prior pretty projection overflowed despite the valid private producer.
  expect(Buffer.byteLength(JSON.stringify(manifest, null, 2) + "\n")).toBeGreaterThan(128 * 1024);
  expect(publicBytes.length).toBeLessThanOrEqual(128 * 1024);
  expect(manifest.files).toHaveLength(JSON.parse(privateBytes.toString()).files.length);
  expect(readJson(path.join(f.destination, "publication.json")).outcome).toBe("passed");
  expectPublicProjection(f);
});

it.each(["write", "rename"] as const)(
  "retries evidence after a failed %s without losing the prior checkpoint",
  (phase) => {
    const root = dirs.make("atomic-evidence-");
    const file = path.join(root, "evidence.json");
    writeInstalledRecoveryEvidence(file, { prior: true });
    const error = new Error(`${phase} failed`);
    const spy =
      phase === "write"
        ? vi.spyOn(fs, "writeFileSync").mockImplementationOnce((fd) => {
            fs.writeSync(fd as number, "partial");
            throw error;
          })
        : vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
            throw error;
          });
    try {
      expect(() => writeInstalledRecoveryEvidence(file, { current: true })).toThrow(error);
    } finally {
      spy.mockRestore();
    }
    expect(readJson(file)).toEqual({ prior: true });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    writeInstalledRecoveryEvidence(file, { current: true });
    expect(readJson(file)).toEqual({ current: true });
  },
);

it("loads the real isolated capture closure without terminal-only dependencies", () => {
  const root = dirs.make("isolated-survivor-capture-");
  const capture = copySurvivorCaptureClosure(root);
  expect(fs.existsSync(path.join(path.dirname(capture), "installed-terminal-observer.mjs"))).toBe(
    false,
  );
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(capture).href)})`],
    { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.signal).toBeNull();
  const artifacts = path.join(root, "artifacts");
  fs.mkdirSync(artifacts);
  const captured = spawnSync(
    process.execPath,
    [capture, "capture", artifacts, "update-candidate", "1"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      },
    },
  );
  expect(captured.status, captured.stderr).toBe(0);
  expect(captured.signal).toBeNull();
});

it.each([
  { exitStatus: 0, timedOut: false, outcome: "passed" },
  { exitStatus: 7, timedOut: false, outcome: "failed" },
  { exitStatus: 128, timedOut: true, outcome: "failed" },
])(
  "publishes every complete export without replacing host outcome: $outcome/$timedOut",
  async (row) => {
    const f = fixture();
    const failure = await publish(f, row.exitStatus, row.timedOut);
    expect(failure?.exitStatus).toBe(row.exitStatus || undefined);
    const report = readJson(path.join(f.destination, "publication.json"));
    expect(report).toMatchObject({
      outcome: row.outcome,
      exitStatus: row.exitStatus,
      host: { processGroupJoined: true, producerSettled: true, timedOut: row.timedOut },
      export: { status: "complete" },
      omissions: {},
    });
    expectPublicProjection(f);
    if (row.exitStatus)
      expect(Object.keys(failure!).sort()).toEqual(["exitStatus", "phase", "signal"]);
    expect(report.export.files).toHaveLength(
      readJson(path.join(f.exported, "manifest.json")).files.length,
    );
  },
);

it.each(["checkpoint", "manifest"] as const)(
  "retains a truthful partial publication when interrupted after %s",
  async (stage) => {
    const f = fixture(stage);
    // An inner passed checkpoint does not establish completed evidence export.
    await expect(publish(f)).rejects.toThrow("Installed terminal proof did not pass");
    const report = readJson(path.join(f.destination, "publication.json"));
    expect(report.outcome).toBe("failed");
    expect(report.omissions["terminal final summary"]).toBeDefined();
    expect(fs.existsSync(path.join(f.destination, "installed-terminal.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.destination, "healthy-update.out.gz"))).toBe(
      stage === "manifest",
    );
    expect(readJson(path.join(f.destination, "partial-diagnostics.json"))).toMatchObject({
      qualification: "diagnostic-only",
      observedStatus: "passed",
      current: { name: "historical-control-update", stdout: "joined update\n", treeJoined: true },
    });
  },
);

it.each([0, 7])(
  "retains a complete failed export and its cleanup errors with host exit %s",
  async (exit) => {
    const f = fixture("checkpoint");
    const [command] = f.summary.commands;
    assert.ok(command);
    const failed = {
      ...f.summary,
      status: "failed",
      runtimeRemoved: false,
      error: "Driver assertion failed",
      commands: [{ ...command, status: "failed", outputComplete: false }],
      cells: [
        {
          name: "healthy",
          historical: false,
          fault: false,
          status: "running",
          cleanup: { status: "held", error: "Owned fixture cleanup failed" },
        },
      ],
    };
    for (const name of cells.slice(1)) {
      fs.rmSync(path.join(f.raw, name), { recursive: true });
      fs.unlinkSync(path.join(f.raw, `${name}-dependencies.json`));
    }
    writeJson(path.join(f.raw, "installed-terminal.json"), failed);
    publishInstalledTerminalEvidence(f.raw, failed);
    writeJson(
      path.join(f.exported, "installed-terminal.json"),
      buildInstalledTerminalSummary(
        failed,
        fs.readFileSync(path.join(f.exported, "manifest.json")),
        (name) => fs.readFileSync(path.join(f.exported, name)),
      ),
    );
    if (exit === 0) {
      await expect(publish(f)).rejects.toThrow("Installed terminal proof did not pass");
    } else {
      expect(await publish(f, exit)).toMatchObject({ exitStatus: exit });
    }
    expectPublicProjection(f);
    expect(readJson(path.join(f.destination, "publication.json"))).toMatchObject({
      outcome: "failed",
      export: { status: "complete" },
    });
    const retained = readJson(path.join(f.destination, "installed-terminal.json"));
    expect(retained.cells).toEqual(failed.cells);
    expect(retained.cells[0]).not.toHaveProperty("installedIdentity");
  },
);

it.each(["symlink", "oversized", "private-fields"] as const)(
  "bounds and redacts raw pre-export diagnostics: %s",
  async (mode) => {
    const f = fixture("checkpoint");
    const secret = "sk-installedTerminalDiagnosticSecret1234567890";
    const checkpoint = {
      ...f.summary,
      status: "running",
      commands: [{ name: "healthy-update", status: "running", args: [secret] }],
      privateConfiguration: secret,
    };
    writeJson(path.join(f.raw, "installed-terminal.json"), checkpoint);
    fs.writeFileSync(path.join(f.raw, "healthy-update.err"), `token=${secret}\n`);
    if (mode === "symlink") {
      fs.unlinkSync(path.join(f.raw, "healthy-update.out"));
      fs.symlinkSync(
        path.join(f.raw, "healthy-update.err"),
        path.join(f.raw, "healthy-update.out"),
      );
    } else if (mode === "oversized") {
      fs.writeFileSync(path.join(f.raw, "healthy-update.out"), "x".repeat(256 * 1024 + 1));
    }
    expect(await publish(f, 128, true)).toMatchObject({ exitStatus: 128 });
    const text = fs.readFileSync(path.join(f.destination, "partial-diagnostics.json"), "utf8");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("privateConfiguration");
    expect(text).not.toContain('"args"');
    expect(JSON.parse(text).current.stdout).toBe(
      mode === "private-fields" ? "joined update\n" : null,
    );
    expect(fs.existsSync(path.join(f.destination, "installed-terminal.json"))).toBe(false);
  },
);

it("publishes available diagnostics after a failed partial run without promoting its checkpoint", async () => {
  const f = fixture("manifest");
  expect(await publish(f, 23)).toMatchObject({ exitStatus: 23, phase: "installed-terminal" });
  expect(readJson(path.join(f.destination, "publication.json"))).toMatchObject({
    outcome: "failed",
    export: { status: "incomplete" },
  });
});

it.each(["missing", "unjoined", "stream-open", "wrong-exit", "wrong-hash"] as const)(
  "requires the actual three completed update receipts: %s",
  async (mode) => {
    const f = fixture();
    const summary = readJson(path.join(f.exported, "installed-terminal.json"));
    const command = summary.commands[1];
    if (mode === "missing") {
      summary.commands.splice(1, 1);
      const manifestPath = path.join(f.exported, "manifest.json");
      const manifest = readJson(manifestPath);
      manifest.files = manifest.files.filter(
        (row: { name: string }) => !row.name.startsWith("late-failure-update."),
      );
      manifest.bytes = manifest.files.reduce(
        (sum: number, row: { bytes: number }) => sum + row.bytes,
        0,
      );
      writeJson(manifestPath, manifest);
      f.finish(summary);
    }
    if (mode === "unjoined") command.treeJoined = false;
    if (mode === "stream-open") command.outputEnded[1] = false;
    if (mode === "wrong-exit") command.exitCode = command.exit.code = 0;
    if (mode === "wrong-hash") command.outputSha256[0] = "f".repeat(64);
    if (mode !== "missing") writeJson(path.join(f.exported, "installed-terminal.json"), summary);
    await expect(publish(f)).rejects.toThrow("Installed terminal proof did not pass");
    expect(readJson(path.join(f.destination, "publication.json")).outcome).toBe("failed");
  },
);

it.each(["short-write", "negative-length", "inflated-gzip"] as const)(
  "rejects invalid decoded output and lengths before publication: %s",
  async (mode) => {
    const f = fixture();
    const manifestPath = path.join(f.exported, "manifest.json");
    const manifest = readJson(manifestPath);
    const entry = manifest.files.find(
      (row: { name: string }) => row.name === "healthy-update.out.gz",
    );
    if (mode === "negative-length") {
      entry.bytes = -1;
    } else {
      const bytes = gzipSync(mode === "short-write" ? "joined" : "x".repeat(8 * 1024 * 1024 + 1));
      fs.writeFileSync(path.join(f.exported, entry.name), bytes);
      Object.assign(entry, { bytes: bytes.length, sha256: hash(bytes) });
    }
    manifest.bytes = manifest.files.reduce(
      (sum: number, row: { bytes: number }) => sum + row.bytes,
      0,
    );
    writeJson(manifestPath, manifest);
    // Rebind the final manifest; rejection must come from the member boundary.
    f.finish();
    await expect(publish(f)).rejects.toThrow("Installed terminal proof did not pass");
    expect(fs.existsSync(path.join(f.destination, entry.name))).toBe(false);
    expect(fs.existsSync(path.join(f.destination, "partial-diagnostics.json"))).toBe(true);
  },
);

it.each(["split-secret", "split-utf8", "multiline-pem"] as const)(
  "redacts whole command streams and omits recoverable stdout chunks: %s",
  async (mode) => {
    const f = fixture("checkpoint");
    const secret = "sk-installedTerminalPublicationSecret1234567890";
    const pemLines = ["ABCDEF1234567890", "ZYXWVUT987654321"];
    const text =
      mode === "multiline-pem"
        ? ["-----BEGIN PRIVATE KEY-----", ...pemLines, "-----END PRIVATE KEY-----", ""].join("\n")
        : `token=${secret}\njoined 🦊 output\n`;
    const output = Buffer.from(text);
    const split =
      mode === "split-utf8"
        ? output.indexOf(Buffer.from("🦊")) + 2
        : mode === "multiline-pem"
          ? output.indexOf("\n") + 1
          : 20;
    const chunks = [output.subarray(0, split), output.subarray(split)];
    fs.writeFileSync(path.join(f.raw, "healthy-update.out"), output);
    const [command] = f.summary.commands;
    assert.ok(command);
    Object.assign(command, {
      outputBytes: [output.length, 0],
      capturedOutputBytes: [output.length, 0],
      outputSha256: [hash(output), hash(Buffer.alloc(0))],
    });
    const trace = path.join(f.raw, "healthy/1-0.jsonl");
    const rows = fs
      .readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    rows.splice(
      2,
      0,
      ...chunks.map((chunk) => ({
        pid: 1,
        thread: 0,
        event: "stdout",
        time: "3",
        bytes: chunk.toString("base64"),
      })),
    );
    fs.writeFileSync(
      trace,
      rows.map((row, sequence) => JSON.stringify({ ...row, sequence }) + "\n").join(""),
    );
    publishInstalledTerminalEvidence(f.raw, f.summary);
    f.finish();
    const original = fs.readFileSync(path.join(f.exported, "healthy-observer.jsonl.gz"));
    await publish(f);
    expectPublicProjection(f);
    const publicTrace = gunzipSync(
      fs.readFileSync(path.join(f.destination, "healthy-observer.jsonl.gz")),
    ).toString();
    const stdout = publicTrace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.event === "stdout");
    expect(stdout).toHaveLength(chunks.length);
    for (const [index, row] of stdout.entries()) {
      const chunk = chunks[index];
      assert.ok(chunk);
      expect(row).not.toHaveProperty("bytes");
      expect(row).toMatchObject({
        outputProjection: "metadata-only",
        capturedBytes: chunk.length,
      });
    }
    const publicOutput = gunzipSync(
      fs.readFileSync(path.join(f.destination, "healthy-update.out.gz")),
    ).toString();
    expect(publicOutput).not.toContain(secret);
    if (mode === "multiline-pem") {
      for (const line of pemLines) expect(publicOutput).not.toContain(line);
      expect(publicOutput).toBe(
        "-----BEGIN PRIVATE KEY-----\n…redacted…\n-----END PRIVATE KEY-----\n",
      );
    } else {
      expect(publicOutput).toContain("joined 🦊 output\n");
    }
    expect(fs.readFileSync(path.join(f.exported, "healthy-observer.jsonl.gz"))).toEqual(original);
    expect(fs.readFileSync(path.join(f.raw, "healthy-update.out"))).toEqual(output);
    expect(readJson(path.join(f.destination, "publication.json")).outcome).toBe("passed");
  },
);

it("retains raw diagnostics when a present final summary is invalid", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.exported, "installed-terminal.json"), "{");
  await expect(publish(f)).rejects.toThrow("Installed terminal proof did not pass");
  expect(readJson(path.join(f.destination, "partial-diagnostics.json")).observedStatus).toBe(
    "passed",
  );
  expect(fs.existsSync(path.join(f.destination, "installed-terminal.json"))).toBe(false);
  expect(fs.existsSync(path.join(f.destination, "healthy-update.out.gz"))).toBe(true);
});

it.each(["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"] as const)(
  "preserves observed %s without inferring it from exit 128",
  async (signal) => {
    const f = fixture();
    expect(
      await publishInstalledTerminalDiagnostics(f.raw, f.destination, redactSensitiveText, {
        exitStatus: 128,
        timedOut: true,
        packageSha256,
        signal,
      }),
    ).toEqual({ phase: "installed-terminal-timeout", exitStatus: 128, signal });
    expect(readJson(path.join(f.destination, "publication.json")).signal).toBe(signal);
  },
);

it.each(["changed", "symlink", "hardlink", "directory", "oversized", "outside"] as const)(
  "refuses an unsafe export member and retains only validated diagnostics: %s",
  async (mode) => {
    const f = fixture();
    const manifestPath = path.join(f.exported, "manifest.json");
    const manifest = readJson(manifestPath);
    const entry = manifest.files.find(
      (file: { name: string }) => file.name === "healthy-update.out.gz",
    );
    const file = path.join(f.exported, entry.name);
    const original = fs.readFileSync(file);
    const sibling = path.join(f.root, "sibling");
    fs.writeFileSync(sibling, original);
    if (mode === "outside") {
      entry.name = "../../sibling";
    } else if (mode === "oversized") {
      entry.bytes = 7 * 1024 * 1024 + 1;
    } else {
      fs.unlinkSync(file);
      if (mode === "changed") {
        const changed = Buffer.from(original);
        const lastByte = changed.at(-1);
        assert(lastByte !== undefined);
        changed[changed.length - 1] = lastByte ^ 1;
        fs.writeFileSync(file, changed);
      }
      if (mode === "symlink") fs.symlinkSync(sibling, file);
      if (mode === "hardlink") fs.linkSync(sibling, file);
      if (mode === "directory") fs.mkdirSync(file);
    }
    manifest.bytes = manifest.files.reduce(
      (sum: number, member: { bytes: number }) => sum + member.bytes,
      0,
    );
    writeJson(manifestPath, manifest);
    await expect(publish(f)).rejects.toThrow("Installed terminal proof did not pass");
    const report = readJson(path.join(f.destination, "publication.json"));
    expect(report.outcome).toBe("failed");
    expect(report.export.files.some((member: { name: string }) => member.name === entry.name)).toBe(
      false,
    );
    expect(fs.readFileSync(sibling)).toEqual(original);
    if (mode !== "oversized")
      expect(report.export.files).toContainEqual(
        expect.objectContaining({ name: "candidate-package-identity.json" }),
      );
  },
);

it.each(["package", "cell", "cleanup", "identity", "manifest-binding"] as const)(
  "never publishes an affirmative result for a mismatched completed export: %s",
  async (mode) => {
    const f = fixture();
    const file = path.join(f.exported, "installed-terminal.json");
    const summary = readJson(file);
    if (mode === "package") summary.sourcePackageSha256 = "e".repeat(64);
    if (mode === "cell") summary.cells.pop();
    if (mode === "cleanup") summary.cells[0].cleanup.joined = false;
    if (mode === "identity") summary.cells[0].installedIdentity.buildInfo.commit = "e".repeat(40);
    if (mode === "manifest-binding") summary.evidence.sha256 = "e".repeat(64);
    writeJson(file, summary);
    await expect(publish(f)).rejects.toThrow("Installed terminal proof did not pass");
    expect(readJson(path.join(f.destination, "publication.json")).outcome).toBe("failed");
    expect(fs.existsSync(path.join(f.destination, "installed-terminal.json"))).toBe(
      ["cleanup", "identity"].includes(mode),
    );
  },
);

it("keeps publication exclusive and never copies unrelated private or sibling-lane files", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.raw, "private-config.json"), "PRIVATE_CONFIG");
  fs.mkdirSync(f.destination);
  fs.writeFileSync(
    path.join(f.destination, "candidate-package-identity.json"),
    "existing publication",
  );
  await expect(publish(f)).rejects.toThrow();
  expect(fs.readFileSync(path.join(f.destination, "candidate-package-identity.json"), "utf8")).toBe(
    "existing publication",
  );
  expect(fs.existsSync(path.join(f.destination, "publication.json"))).toBe(false);
  expect(fs.existsSync(path.join(f.destination, "private-config.json"))).toBe(false);
});
