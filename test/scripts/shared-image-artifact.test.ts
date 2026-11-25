import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const HELPER = resolve("scripts/docker/shared-image-artifact.sh");
const TARGET_SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const PACKAGE_SHA256 = "c".repeat(64);
const ARTIFACT_DIGEST = "d".repeat(64);
const ARTIFACT_ID = "789";
const ARTIFACT_NAME = "docker-e2e-shared-images-release-aabbccddeeff-123456-2";
const ARTIFACT_RUN_ATTEMPT = "2";
const ARTIFACT_RUN_ID = "123456";
const IMAGE_REFS = ["openclaw-docker-e2e-bare:pkg-test", "openclaw-docker-e2e-functional:pkg-test"];

function imageId(ref: string): string {
  return `sha256:${createHash("sha256").update(ref).digest("hex")}`;
}

// Docker config IDs are fixture data; the production archive digest stays independently checked.
const imageIds = Object.fromEntries(
  IMAGE_REFS.flatMap((ref) => [ref, `mismatch:${ref}`]).map((ref) => [ref, imageId(ref)]),
);

function runHelper(
  fixture: ReturnType<typeof createFixture>,
  command: "load" | "pack",
  env: NodeJS.ProcessEnv = fixture.env,
  imageRefs = IMAGE_REFS,
  artifactDir = fixture.artifactDir,
) {
  return spawnSync(
    "bash",
    [HELPER, command, artifactDir, "docker-e2e", TARGET_SHA, WORKFLOW_SHA, ...imageRefs],
    {
      encoding: "utf8",
      env,
    },
  );
}

function verifyUploadedArtifact(
  fixture: ReturnType<typeof createFixture>,
  params: {
    artifactDigest?: string;
    env?: NodeJS.ProcessEnv;
    json?: boolean;
  } = {},
) {
  return spawnSync(
    "bash",
    [
      HELPER,
      "verify-upload",
      "Docker E2E image",
      ARTIFACT_ID,
      ARTIFACT_NAME,
      params.artifactDigest ?? ARTIFACT_DIGEST,
      ARTIFACT_RUN_ID,
      ARTIFACT_RUN_ATTEMPT,
      ...(params.json ? ["--json"] : []),
    ],
    {
      encoding: "utf8",
      env: { ...fixture.env, ...params.env },
    },
  );
}

function verifyApiFailure(
  fixture: ReturnType<typeof createFixture>,
  error: string,
  failures: string,
  target = "ARTIFACT",
) {
  return verifyUploadedArtifact(fixture, {
    env: { [`FAKE_GH_${target}_ERROR`]: error, [`FAKE_GH_${target}_FAILURES`]: failures },
  });
}

function expectApiResult(
  result: ReturnType<typeof verifyUploadedArtifact>,
  fixture: ReturnType<typeof createFixture>,
  expected: {
    success: boolean;
    sleeps: string;
    artifacts: number;
    attempts: number;
    messages: string[];
  },
) {
  expect(result.status === 0, `${result.stdout}\n${result.stderr}`).toBe(expected.success);
  expect(readFileSync(fixture.sleepLog, "utf8")).toBe(expected.sleeps);
  const calls = readFileSync(fixture.ghLog, "utf8");
  expect(calls.match(/actions\/artifacts/g) ?? []).toHaveLength(expected.artifacts);
  expect(calls.match(/actions\/runs/g) ?? []).toHaveLength(expected.attempts);
  for (const message of expected.messages) {
    expect(result.stderr).toContain(message);
  }
}

function expectRejectedUpload(
  fixture: ReturnType<typeof createFixture>,
  options: Parameters<typeof verifyUploadedArtifact>[1],
  message: string,
  calls: number,
) {
  writeFileSync(fixture.ghLog, "");
  const result = verifyUploadedArtifact(fixture, options);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
  expect(readFileSync(fixture.ghLog, "utf8").trim().split("\n")).toHaveLength(calls);
  expect(result.stderr).not.toContain("retrying");
}

function createFixture() {
  const root = temps.make("openclaw-shared-image-artifact-");
  const bin = join(root, "bin");
  const artifactDir = join(root, "artifact");
  const dockerLog = join(root, "docker.log");
  const ghLog = join(root, "gh.log");
  const ghState = join(root, "gh-state");
  const sleepLog = join(root, "sleep.log");
  mkdirSync(bin);
  mkdirSync(ghState);
  writeFileSync(dockerLog, "");
  writeFileSync(ghLog, "");
  writeFileSync(sleepLog, "");

  const runner = join(root, "tools.cjs");
  writeFileSync(
    runner,
    `
const fs = require("node:fs");
const path = require("node:path");
const [tool, ...args] = process.argv.slice(2);
const env = process.env;
const ids = ${JSON.stringify(imageIds)};
const emit = (value) => process.stdout.write(value);
const fail = (message) => { console.error(message); process.exit(2); };
if (tool !== "zstd") fs.appendFileSync(env["FAKE_" + tool.toUpperCase() + "_LOG"], args.join(" ") + "\\n");
if (tool === "docker") {
  const id = (ref) => ids[ref] ?? fail("unexpected fixture image ref: " + ref);
  if (args[0] !== "image") fail("unexpected docker invocation");
  if (args[1] === "inspect") {
    emit(id((env.FAKE_DOCKER_FORCE_ID_MISMATCH === "1" ? "mismatch:" : "") + args[4]) + "\\n");
  } else if (args[1] === "save") {
    const refs = args.slice(2);
    const index = refs.indexOf("--output");
    if (index < 0) fail("missing image output");
    const [, output] = refs.splice(index, 2);
    fs.writeFileSync(output, refs.map((ref) => ref + "\\t" + id(ref) + "\\n").join(""));
  } else if (args[1] === "load") {
    fs.readFileSync(0);
  } else fail("unexpected docker invocation");
} else if (tool === "zstd") {
  if (args[0] === "-t") {
    if (!fs.statSync(args[1]).size) process.exit(1);
  } else if (args[0] === "-d" && args[1] === "--stdout") {
    emit(fs.readFileSync(args[2]));
  } else {
    fs.copyFileSync(args[args.indexOf("-f") + 1], args[args.indexOf("-o") + 1]);
  }
} else if (tool === "gh") {
  if (args.shift() !== "api") fail("unexpected gh invocation");
  let method = "GET";
  let endpoint;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--method") method = args.shift();
    else if (endpoint) fail("unexpected gh api argument: " + arg);
    else endpoint = arg;
  }
  if (method !== "GET") fail("unexpected gh api method: " + method);
  const base = "repos/" + env.GITHUB_REPOSITORY + "/actions/";
  const kind = endpoint === base + "artifacts/${ARTIFACT_ID}" ? "artifact"
    : endpoint === base + "runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}" ? "attempt" : null;
  if (!kind) fail("unexpected gh api path: " + endpoint);
  const counter = path.join(env.FAKE_GH_STATE, kind);
  const count = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  fs.writeFileSync(counter, count + "\\n");
  if (count <= Number(env["FAKE_GH_" + kind.toUpperCase() + "_FAILURES"] || 0)) {
    emit("partial " + kind + " response\\n");
    console.error(env["FAKE_GH_" + kind.toUpperCase() + "_ERROR"] || "gh: request failed");
    process.exit(Number(env.FAKE_GH_EXIT_STATUS || 1));
  }
  const value = kind === "artifact" ? {
    id: Number(env.FAKE_ARTIFACT_ID), name: env.FAKE_ARTIFACT_NAME,
    expired: env.FAKE_ARTIFACT_EXPIRED === "true", digest: "sha256:" + env.FAKE_ARTIFACT_DIGEST,
    workflow_run: { id: Number(env.FAKE_ARTIFACT_RUN_ID) }, expires_at: "2030-01-01T00:00:00Z",
  } : { id: Number(env.FAKE_ATTEMPT_RUN_ID), run_attempt: Number(env.FAKE_ARTIFACT_RUN_ATTEMPT) };
  emit((kind === "artifact" && env.FAKE_ARTIFACT_JSON || JSON.stringify(value)) + "\\n");
}
`,
  );
  for (const tool of ["docker", "zstd", "gh", "sleep"]) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`,
      { mode: 0o755 },
    );
  }

  const env = {
    ...process.env,
    FAKE_ARTIFACT_DIGEST: ARTIFACT_DIGEST,
    FAKE_ARTIFACT_EXPIRED: "false",
    FAKE_ARTIFACT_ID: ARTIFACT_ID,
    FAKE_ARTIFACT_NAME: ARTIFACT_NAME,
    FAKE_ARTIFACT_RUN_ATTEMPT: ARTIFACT_RUN_ATTEMPT,
    FAKE_ARTIFACT_RUN_ID: ARTIFACT_RUN_ID,
    FAKE_ATTEMPT_RUN_ID: ARTIFACT_RUN_ID,
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_GH_LOG: ghLog,
    FAKE_GH_STATE: ghState,
    FAKE_SLEEP_LOG: sleepLog,
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "123456",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RUNNER_TEMP: root,
    OPENCLAW_SHARED_IMAGE_PACKAGE_SHA256: PACKAGE_SHA256,
  };
  return { artifactDir, dockerLog, env, ghLog, root, sleepLog };
}

function expectedArchiveEnv(fixture: ReturnType<typeof createFixture>): NodeJS.ProcessEnv {
  const manifest = JSON.parse(
    readFileSync(join(fixture.artifactDir, "shared-image-artifact.json"), "utf8"),
  );
  return {
    ...fixture.env,
    OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256: manifest.archive.sha256,
    OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT: String(manifest.runAttempt),
    OPENCLAW_SHARED_IMAGE_RUN_ID: String(manifest.runId),
  };
}

function createPackedFixture() {
  const fixture = createFixture();
  const packed = runHelper(fixture, "pack");
  expect(packed.status, packed.stderr).toBe(0);
  return fixture;
}

function expectRejectedLoad(
  fixture: ReturnType<typeof createFixture>,
  env: NodeJS.ProcessEnv,
  message: string,
  imageRefs = IMAGE_REFS,
) {
  writeFileSync(fixture.dockerLog, "");
  const result = runHelper(fixture, "load", env, imageRefs);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(readFileSync(fixture.dockerLog, "utf8")).not.toContain("image load");
}

describe("shared Docker image artifacts", () => {
  it.each(["2", "3"])("propagates expiry verification for producer attempt %s", (attempt) => {
    const fixture = createFixture();
    const harnessScripts = join(fixture.root, ".release-harness/scripts/docker");
    mkdirSync(harnessScripts, { recursive: true });
    copyFileSync(HELPER, join(harnessScripts, "shared-image-artifact.sh"));
    const workflow = readFileSync(
      resolve(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml"),
      "utf8",
    );
    const expiry = expectDefined(
      workflow.match(/ {10}artifact_expiry\(\) \{[\s\S]*?\n {10}\}/)?.[0],
      "release artifact expiry function",
    );
    // The workflow captures this function's stdout; that disables Bash's implicit errexit.
    const result = spawnSync(
      "bash",
      [
        "-ec",
        `${expiry}\nvalue="$(artifact_expiry "$@")"\nprintf '%s' "$value"`,
        "expiry",
        "Docker E2E image",
        ARTIFACT_ID,
        ARTIFACT_NAME,
        ARTIFACT_DIGEST,
        ARTIFACT_RUN_ID,
        ARTIFACT_RUN_ATTEMPT,
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: { ...fixture.env, FAKE_ARTIFACT_RUN_ATTEMPT: attempt },
      },
    );
    expect(result.status === 0, result.stderr).toBe(attempt === ARTIFACT_RUN_ATTEMPT);
    expect(result.stdout).toBe(attempt === ARTIFACT_RUN_ATTEMPT ? "2030-01-01T00:00:00Z" : "");
    expect(readFileSync(fixture.ghLog, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it.each([false, true])("binds uploaded artifacts before returning metadata (json=%s)", (json) => {
    const fixture = createFixture();
    const verified = verifyUploadedArtifact(fixture, { json });
    expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0);
    expect(json ? JSON.parse(verified.stdout).expires_at : verified.stdout).toBe(
      json ? "2030-01-01T00:00:00Z" : "",
    );
    expect(readFileSync(fixture.ghLog, "utf8").trim().split("\n")).toHaveLength(2);
    const mismatch = "artifact identity does not match the immutable producer tuple";
    expectRejectedUpload(fixture, { json, artifactDigest: "e".repeat(64) }, mismatch, 1);
    expectRejectedUpload(fixture, { json, env: { FAKE_ARTIFACT_JSON: "not-json" } }, mismatch, 1);
    expectRejectedUpload(
      fixture,
      { json, env: { FAKE_ARTIFACT_RUN_ATTEMPT: "3" } },
      "producer run attempt does not match the immutable tuple",
      2,
    );
  });

  it.each([
    ["gh: Not Found (HTTP 404)", "1", "ARTIFACT", true, "2\n", 2, 1],
    ["gh: Not Found (HTTP 404)", "3", "ATTEMPT", false, "", 1, 1],
    ["gh: upstream unavailable (HTTP 503)", "2", "ARTIFACT", true, "2\n4\n", 3, 1],
    ["Get https://api.github.com: dial tcp: i/o timeout", "3", "ARTIFACT", false, "2\n4\n", 3, 0],
    ["gh: API rate limit exceeded (HTTP 429)", "1", "ARTIFACT", true, "2\n", 2, 1],
  ] as const)(
    "handles %s after %s failures in %s",
    (error, failures, target, success, sleeps, artifacts, attempts) => {
      const fixture = createFixture();
      const result = verifyApiFailure(fixture, error, failures, target);
      const messages =
        success && error.includes("404")
          ? ["artifact metadata GitHub API GET failed transiently on attempt 1/3; retrying in 2s"]
          : success
            ? []
            : [`GitHub API GET failed after ${artifacts === 3 ? 3 : 1} attempt(s)`];
      expectApiResult(result, fixture, { success, sleeps, artifacts, attempts, messages });
      if (!sleeps) {
        expect(result.stderr).not.toContain("retrying");
      }
      if (!attempts) {
        expect(result.stdout).not.toContain("partial artifact response");
        expect(result.stderr).toContain("i/o timeout");
      }
    },
  );

  it.each([
    [124, "ARTIFACT", "1", true, 2, 1],
    [137, "ATTEMPT", "1", true, 1, 2],
    [124, "ARTIFACT", "3", false, 3, 0],
    [137, "ATTEMPT", "3", false, 1, 3],
  ] as const)(
    "handles deadline exit %s for %s after %s failures",
    (status, target, failures, success, artifacts, attempts) => {
      const fixture = createFixture();
      const result = verifyUploadedArtifact(fixture, {
        env: {
          FAKE_GH_EXIT_STATUS: String(status),
          [`FAKE_GH_${target}_FAILURES`]: failures,
        },
      });
      expectApiResult(result, fixture, {
        success,
        sleeps: success ? "2\n" : "2\n4\n",
        artifacts,
        attempts,
        messages: ["GitHub API GET exceeded the 30s request deadline."],
      });
      expect(result.stdout).not.toContain("partial");
      if (!success) {
        expect(result.stderr).toContain("GitHub API GET failed after 3 attempt(s)");
      }
    },
  );

  it("fails fast on permanent HTTP and credential errors", () => {
    for (const error of [
      "gh: Unauthorized (HTTP 401)",
      "gh: Forbidden (HTTP 403)",
      "gh: Unprocessable Entity (HTTP 422)",
      "gh: Bad credentials (HTTP 500)",
      "gh: authentication failed (HTTP 500)",
    ]) {
      const fixture = createFixture();
      const failed = verifyApiFailure(fixture, error, "3");
      expect(failed.status, error).not.toBe(0);
      expect(failed.stderr).toContain(error);
      expect(failed.stderr).toContain("GitHub API GET failed after 1 attempt(s)");
      expect(failed.stderr).not.toContain("retrying");
      expect(readFileSync(fixture.ghLog, "utf8").trim().split("\n")).toHaveLength(1);
      expect(readFileSync(fixture.sleepLog, "utf8")).toBe("");
    }
  });

  it("packs provenance-bound images and verifies them before loading", () => {
    const fixture = createPackedFixture();

    const manifest = JSON.parse(
      readFileSync(join(fixture.artifactDir, "shared-image-artifact.json"), "utf8"),
    );
    // Loading validates the full manifest, archive bytes, refs and config IDs.
    // These producer values need an independent expectation, not manifest-derived input.
    expect(manifest).toMatchObject({ runAttempt: 2, runId: 123456 });

    writeFileSync(fixture.dockerLog, "");
    const loaded = runHelper(fixture, "load", {
      ...expectedArchiveEnv(fixture),
      GITHUB_RUN_ATTEMPT: "3",
    });
    expect(loaded.status, `${loaded.stdout}\n${loaded.stderr}`).toBe(0);
    const calls = readFileSync(fixture.dockerLog, "utf8");
    expect(calls).toContain("image load");
    for (const ref of IMAGE_REFS) {
      expect(calls).toContain(`image inspect --format {{.Id}} ${ref}`);
    }
  });

  it("fails before loading when provenance or archive bytes differ", () => {
    const fixture = createPackedFixture();
    for (const [key, value, message] of [
      ["OPENCLAW_SHARED_IMAGE_RUN_ID", "654321", "run ID"],
      ["OPENCLAW_SHARED_IMAGE_PACKAGE_SHA256", "d".repeat(64), "package SHA-256"],
    ] as const) {
      expectRejectedLoad(fixture, { ...expectedArchiveEnv(fixture), [key]: value }, message);
    }
    expectRejectedLoad(fixture, expectedArchiveEnv(fixture), "image ref 1", [
      expectDefined(IMAGE_REFS[0], "first shared Docker image reference"),
      "openclaw-docker-e2e-functional:wrong",
    ]);

    const archivePath = join(fixture.artifactDir, "shared-images.tar.zst");
    writeFileSync(archivePath, `${readFileSync(archivePath, "utf8")}tampered`);
    expectRejectedLoad(fixture, expectedArchiveEnv(fixture), "archive SHA-256 mismatch");
  });

  it("rejects unsafe pack destinations and loaded image ID drift", () => {
    const fixture = createFixture();
    const unsafe = runHelper(fixture, "pack", fixture.env, IMAGE_REFS, fixture.root);
    expect(unsafe.status).not.toBe(0);
    expect(unsafe.stderr).toContain("artifact directory must be a child of RUNNER_TEMP");

    const packed = runHelper(fixture, "pack");
    expect(packed.status, packed.stderr).toBe(0);

    writeFileSync(fixture.dockerLog, "");
    const mismatch = runHelper(fixture, "load", {
      ...expectedArchiveEnv(fixture),
      FAKE_DOCKER_FORCE_ID_MISMATCH: "1",
    });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("loaded ID mismatch");
    expect(readFileSync(fixture.dockerLog, "utf8")).toContain("image load");
  });

  it("requires an external expected archive digest before loading", () => {
    const fixture = createPackedFixture();

    const missingRunEnv = expectedArchiveEnv(fixture);
    delete missingRunEnv.OPENCLAW_SHARED_IMAGE_RUN_ID;
    delete missingRunEnv.OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT;
    expectRejectedLoad(fixture, missingRunEnv, "OPENCLAW_SHARED_IMAGE_RUN_ID");

    const expectedEnv = expectedArchiveEnv(fixture);
    for (const [digest, message] of [
      [undefined, "expected shared image archive SHA-256"],
      ["d".repeat(64), "expected archive sha256"],
    ] as const) {
      expectRejectedLoad(
        fixture,
        {
          ...expectedEnv,
          OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256: digest,
        },
        message,
      );
    }
  });
});
