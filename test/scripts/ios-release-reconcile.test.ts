import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  createEvidence,
  readCanonicalJson,
  validateEvidence,
  validateOriginalReceipt,
  validateStoreObservation,
} from "../../scripts/ios-release-reconcile.mjs";

const candidate = "d69752a1c90715e74a36652b2e64c41e9409c5fd";
const workflowSha = "8977ea332fbf9ba0a8ddc6c75af4ad7f27cee82e";
const originalReceiptBytes = Buffer.from(
  '{"actor":"vincentkoc","gatewayVersion":"2026.9.2","androidPhoneVersionCode":"2026090201","androidVersionName":"2026.9.2","androidWearVersionCode":"2026090251","iosAppStoreVersion":"2026.9.20","buildTimestamp":"2026-09-09T23:58:39.000Z","kind":"openclaw-mobile-release-authority","platform":"ios","repository":"openclaw/openclaw","runAttempt":1,"runId":"34419244851","schemaVersion":2,"targetRef":"release/2026.9.2-mobile","targetSha":"d69752a1c90715e74a36652b2e64c41e9409c5fd","triggeringActor":"vincentkoc","workflowFullRef":"openclaw/openclaw/.github/workflows/ios-beta-release.yml@refs/heads/main","workflowPath":".github/workflows/ios-beta-release.yml","workflowSha":"2f80c55e067e16f6758080f8bbade621b8bed4a3"}\n',
  "utf8",
);
const originalReceipt = JSON.parse(originalReceiptBytes.toString("utf8"));
const primaryGroup = "group-primary";

function candidateEvidence() {
  return {
    appStoreRevision: 0,
    appStoreVersion: "2026.9.20",
    blobs: {
      "apps/android/Config/Version.properties": {
        blob: "4ca596d1a75b59ee2e483b89e01583b14dda3103",
        sha256: "94bb41004694671c3ddec604888ac7fbbed39138a4177027e17cd57c6bf29c1d",
      },
      "apps/android/fastlane/metadata/android/en-US/release_notes.txt": {
        blob: "d58d36ed1e0fc065a0979e79e1820a0c3b463040",
        sha256: "6ad1729a931f40402ef74b98ec7a8eeb577e6820d73173d138e8cbb111af423f",
      },
      "apps/android/version.json": {
        blob: "e23736e482447ad9406af523d70eb71c6938251f",
        sha256: "058ee5457eab2874d355af95718c79d88a04878a24527c8f3e4ac520300abec1",
      },
      "apps/ios/CHANGELOG.md": {
        blob: "21704cd513620b4ffb0c5be7ecb7b4dfd6cb1ae3",
        sha256: "9cf7026c8afe25076ff54f459fed9db5c0fca54f801e3c8958f32ccdad79cd3a",
      },
      "apps/mobile/version.json": {
        blob: "84b723e9baae35cb630e0bff0a6f60b9a7f0e681",
        sha256: "442b18aed43b26ccae103e3dfbb5c05d86a26c494a92b37208e3d3c89cf1a4ca",
      },
    },
    buildNumber: "1",
    changedPaths: [
      "apps/android/Config/Version.properties",
      "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
      "apps/android/version.json",
      "apps/ios/CHANGELOG.md",
      "apps/mobile/version.json",
    ],
    commit: candidate,
    gatewayVersion: "2026.9.2",
    parent: "d3f01d9851f46649c5cfbf7d8ccb3965b73bf8d3",
    tree: "e3f07b8d0064bc38aafc29847c1faa542f6c6240",
  };
}

function storeObservation() {
  return {
    app: { bundleId: "com.example.release", id: "1234567890" },
    build: {
      appStoreVersion: "2026.9.20",
      buildNumber: "1",
      expired: false,
      id: "build-1",
      internalBuildState: "READY_FOR_BETA_TESTING",
      platform: "IOS",
      processingState: "VALID",
    },
    configuredGroupId: primaryGroup,
    groups: [
      {
        containsBuild: true,
        hasAccessToAllBuilds: true,
        id: primaryGroup,
        isInternalGroup: true,
      },
      {
        containsBuild: false,
        hasAccessToAllBuilds: false,
        id: "another-internal-group",
        isInternalGroup: true,
      },
    ],
    kind: "openclaw-ios-release-store-observation",
    observedAt: "2026-09-26T18:00:00.000Z",
    readOnly: true,
    schemaVersion: 1,
    upload: {
      buildNumber: "1",
      id: "upload-1",
      platform: "IOS",
      shortVersion: "2026.9.20",
      state: { errors: [], infos: [], state: "COMPLETE", warnings: [] },
      uploadedAt: "2026-09-10T00:55:00.000Z",
    },
  };
}

function storeObservationWithState(state: unknown) {
  const observation = storeObservation();
  return {
    ...observation,
    upload: {
      ...observation.upload,
      state,
    },
  };
}

function evidence(observation = storeObservation()) {
  return createEvidence({
    actor: "vincentkoc",
    candidate: candidateEvidence(),
    currentRunAttempt: "1",
    currentRunId: "40000000000",
    currentWorkflowSha: workflowSha,
    originalReceipt,
    originalReceiptArtifactId: "10130298326",
    observation,
  });
}

function recordArgs(root: string, targetSha = candidate) {
  return [
    path.resolve("scripts/ios-release-reconcile.mjs"),
    "record",
    "--original-receipt",
    path.join(root, "receipt.json"),
    "--original-receipt-artifact-id",
    "10130298326",
    "--source-run-id",
    "34419244851",
    "--source-job-id",
    "102691169741",
    "--source-receipt-digest",
    "98b4ddf27f890b5263c81b2a00537161446757ebe9cb109b9c923b1591992e04",
    "--target-ref",
    "release/2026.9.2-mobile",
    "--target-sha",
    targetSha,
    "--build-number",
    "1",
    "--upload-log-digest",
    "dd61760ccd733f7be78e1e5f162a59f6f18e7b4f806950cf080b53ce44f99bbd",
    "--group-id",
    primaryGroup,
    "--evidence-artifact-id",
    "20000000000",
    "--evidence-artifact-digest",
    "a".repeat(64),
    "--evidence-path",
    path.join(root, "evidence.json"),
  ];
}

function runRecordAuthorityFixture({
  currentPath,
  originalPath,
  staleAfterRemoteRead = false,
}: {
  currentPath: string;
  originalPath: string;
  staleAfterRemoteRead?: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "ios-reconcile-authority-"));
  const scripts = path.join(root, "scripts");
  const recorderSentinel = path.join(root, "recorder-called");
  const preload = path.join(root, "preload.mjs");
  const originalWorkflowSha = originalReceipt.workflowSha;
  const currentRunId = "40000000000";
  mkdirSync(scripts, { recursive: true });
  writeFileSync(path.join(root, "receipt.json"), originalReceiptBytes, { mode: 0o600 });
  writeFileSync(path.join(root, "evidence.json"), canonicalBytes(evidence()), { mode: 0o600 });
  writeFileSync(path.join(scripts, "tsx.mjs"), "", { mode: 0o600 });
  writeFileSync(path.join(scripts, "mobile-release-ref.ts"), "", { mode: 0o600 });
  writeFileSync(
    preload,
    [
      'import childProcess from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "let remoteRead = false;",
      `const staleAfterRemoteRead = ${JSON.stringify(staleAfterRemoteRead)};`,
      `const freshNow = ${Date.parse("2026-09-26T18:10:00.000Z")};`,
      `const staleNow = ${Date.parse("2026-09-26T18:30:00.001Z")};`,
      "Date.now = () => remoteRead && staleAfterRemoteRead ? staleNow : freshNow;",
      "const originalExec = childProcess.execFileSync;",
      "const originalSpawn = childProcess.spawnSync;",
      "const responses = new Map([",
      `  ["repos/openclaw/openclaw/actions/artifacts/10130298326", ${JSON.stringify({
        expired: false,
        id: 10130298326,
        name: "mobile-release-ref-ios-34419244851-1",
        workflow_run: { head_sha: originalWorkflowSha, id: 34419244851 },
      })}],`,
      `  ["repos/openclaw/openclaw/actions/runs/34419244851", ${JSON.stringify({
        actor: { login: "vincentkoc" },
        conclusion: "failure",
        event: "workflow_dispatch",
        head_sha: originalWorkflowSha,
        path: originalPath,
        run_attempt: 1,
        status: "completed",
        triggering_actor: { login: "vincentkoc" },
      })}],`,
      `  ["repos/openclaw/openclaw/actions/jobs/102691169741", ${JSON.stringify({
        completed_at: "2026-09-10T01:40:28Z",
        conclusion: "failure",
        head_sha: originalWorkflowSha,
        name: "Upload and record iOS beta",
        run_attempt: 1,
        run_id: 34419244851,
        started_at: "2026-09-10T00:04:43Z",
        status: "completed",
      })}],`,
      '  ["repos/openclaw/openclaw/collaborators/vincentkoc/permission", {"permission":"maintain"}],',
      `  ["repos/openclaw/openclaw/actions/artifacts/20000000000", ${JSON.stringify({
        digest: `sha256:${"a".repeat(64)}`,
        expired: false,
        id: 20000000000,
        name: `ios-release-reconciliation-${currentRunId}-1`,
        workflow_run: { head_sha: workflowSha, id: Number(currentRunId) },
      })}],`,
      `  ["repos/openclaw/openclaw/actions/runs/${currentRunId}", ${JSON.stringify({
        actor: { login: "vincentkoc" },
        conclusion: null,
        event: "workflow_dispatch",
        head_sha: workflowSha,
        path: currentPath,
        run_attempt: 1,
        status: "in_progress",
        triggering_actor: { login: "vincentkoc" },
      })}],`,
      "]);",
      "childProcess.execFileSync = function(file, args, options) {",
      '  if (file === "gh") {',
      "    remoteRead = true;",
      "    const response = responses.get(args?.[1]);",
      "    if (!response) throw new Error(`unexpected gh endpoint: ${args?.[1]}`);",
      "    return JSON.stringify(response);",
      "  }",
      '  if (args?.some((arg) => String(arg).endsWith("mobile-release-ref.ts"))) {',
      `    writeFileSync(${JSON.stringify(recorderSentinel)}, "called");`,
      "  }",
      "  return originalExec.call(this, file, args, options);",
      "};",
      "childProcess.spawnSync = function(file, args, options) {",
      '  if (file === "git") {',
      "    remoteRead = true;",
      "    const ref = args?.at(-1);",
      '    if (ref === "refs/heads/release/2026.9.2-mobile") {',
      `      return { error: undefined, signal: null, status: 0, stderr: "", stdout: ${JSON.stringify(
        `${candidate}\trefs/heads/release/2026.9.2-mobile\n`,
      )} };`,
      "    }",
      '    if (ref === "refs/openclaw/mobile-releases/ios/2026.9.20-1") {',
      '      return { error: undefined, signal: null, status: 2, stderr: "", stdout: "" };',
      "    }",
      "    throw new Error(`unexpected git ref: ${ref}`);",
      "  }",
      "  return originalSpawn.call(this, file, args, options);",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  try {
    const result = spawnSync(process.execPath, ["--import", preload, ...recordArgs(root)], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTOR: "vincentkoc",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: currentRunId,
        GITHUB_TRIGGERING_ACTOR: "vincentkoc",
        GITHUB_WORKFLOW_REF: "openclaw/openclaw/.github/workflows/ios-release.yml@refs/heads/main",
        GITHUB_WORKFLOW_SHA: workflowSha,
        GITHUB_WORKSPACE: root,
      },
    });
    return { recorderCalled: existsSync(recorderSentinel), result };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("iOS release same-build reconciliation", () => {
  it("accepts the exact historical receipt and a unique read-only store observation", () => {
    expect(validateOriginalReceipt(originalReceipt)).toBe(originalReceipt);
    expect(validateStoreObservation(storeObservation())).toMatchObject({
      readOnly: true,
      upload: { state: { state: "COMPLETE" } },
      build: { processingState: "VALID", expired: false },
    });
    expect(
      validateEvidence(evidence(), {
        now: Date.parse("2026-09-26T18:10:00.000Z"),
      }),
    ).toMatchObject({
      targetSha: candidate,
      store: {
        assignedGroupIds: [primaryGroup],
        internalBuildState: "READY_FOR_BETA_TESTING",
        nonTargetAutomaticGroupIds: [],
        targetAllBuilds: true,
      },
    });
  });

  it.each([
    ["scalar", "COMPLETE"],
    ["blank", { errors: [], infos: [], state: "", warnings: [] }],
    ["unknown", { errors: [], infos: [], state: "SURPRISE", warnings: [] }],
    ["missing", {}],
    ["malformed diagnostics", { errors: null, infos: [], state: "COMPLETE", warnings: [] }],
    ["malformed diagnostic entry", { errors: [{ code: 7 }], state: "COMPLETE" }],
    ["extra state field", { state: "COMPLETE", unexpected: [] }],
  ])("rejects malformed BuildUpload state: %s", (_name, state) => {
    const observation = storeObservationWithState(state);
    expect(() => validateStoreObservation(observation)).toThrow("Build upload state");
  });

  it("accepts omitted diagnostics and closed string diagnostic entries", () => {
    for (const state of [
      { state: "COMPLETE" },
      {
        errors: [{}],
        state: "COMPLETE",
        warnings: [{ code: "notice", description: "retained warning" }],
      },
    ]) {
      const observation = storeObservationWithState(state);
      expect(validateStoreObservation(observation)).toBe(observation);
    }
  });

  it("rejects an upload outside the original job interval", () => {
    const observation = storeObservation();
    observation.upload.uploadedAt = "2026-09-10T01:40:29.000Z";
    expect(() => validateStoreObservation(observation)).toThrow(
      "outside the original job interval",
    );
  });

  it("rejects extra build assignment and non-target automatic access", () => {
    const assigned = storeObservation();
    assigned.groups[1]!.containsBuild = true;
    expect(() => validateStoreObservation(assigned)).toThrow("not exclusive");

    const automatic = storeObservation();
    automatic.groups[1]!.hasAccessToAllBuilds = true;
    expect(() => validateStoreObservation(automatic)).toThrow(
      "non-target internal group has automatic access",
    );

    const targetWithoutAutomaticAccess = storeObservation();
    targetWithoutAutomaticAccess.groups[0]!.hasAccessToAllBuilds = false;
    expect(() => validateStoreObservation(targetWithoutAutomaticAccess)).toThrow(
      "automatic internal group",
    );
  });

  it("rejects expired, invalid, or substituted TestFlight builds", () => {
    for (const update of [
      { expired: true },
      { processingState: "PROCESSING" },
      { internalBuildState: "MISSING_EXPORT_COMPLIANCE" },
      { appStoreVersion: "2026.9.21" },
      { buildNumber: "2" },
    ]) {
      const observation = storeObservation();
      Object.assign(observation.build, update);
      expect(() => validateStoreObservation(observation)).toThrow(
        "not the unique valid unexpired target",
      );
    }
  });

  it("rejects stale evidence and original receipt substitution", () => {
    expect(() =>
      validateEvidence(evidence(), {
        now: Date.parse("2026-09-26T18:35:00.001Z"),
      }),
    ).toThrow("evidence is stale");

    expect(() => validateOriginalReceipt({ ...originalReceipt, actor: "different-user" })).toThrow(
      "Original authority actor is invalid",
    );
    expect(() => validateOriginalReceipt({ ...originalReceipt, targetSha: workflowSha })).toThrow(
      "targetSha mismatch",
    );

    const substitutedCandidate = evidence();
    substitutedCandidate.candidate.tree = workflowSha;
    expect(() =>
      validateEvidence(substitutedCandidate, {
        now: Date.parse("2026-09-26T18:10:00.000Z"),
      }),
    ).toThrow("Candidate evidence identity mismatch");
  });

  it("requires the retained original receipt bytes and exact canonical bounded files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ios-reconcile-"));
    const canonical = path.join(root, "canonical.json");
    const noncanonical = path.join(root, "noncanonical.json");
    const link = path.join(root, "link.json");
    expect(originalReceiptBytes).toHaveLength(715);
    expect(createHash("sha256").update(originalReceiptBytes).digest("hex")).toBe(
      "98b4ddf27f890b5263c81b2a00537161446757ebe9cb109b9c923b1591992e04",
    );
    expect(canonicalBytes(originalReceipt)).toEqual(originalReceiptBytes);
    writeFileSync(canonical, originalReceiptBytes, { mode: 0o600 });
    writeFileSync(noncanonical, JSON.stringify(originalReceipt, null, 2), { mode: 0o600 });
    symlinkSync(canonical, link);

    expect(readCanonicalJson(canonical, "receipt").value).toEqual(originalReceipt);
    expect(() => readCanonicalJson(noncanonical, "receipt")).toThrow("not canonical JSON");
    expect(() => readCanonicalJson(link, "receipt")).toThrow("bounded regular file");

    chmodSync(canonical, 0o622);
    expect(() => readCanonicalJson(canonical, "receipt")).toThrow(
      "must not be group- or world-writable",
    );
  });

  it("keeps original authority and fresh evidence as distinct schemas", () => {
    const fresh = evidence();
    expect(fresh.kind).toBe("openclaw-ios-release-reconciliation");
    expect(fresh.kind).not.toBe(originalReceipt.kind);
    expect(fresh.originalReceiptDigest).toBe(
      "98b4ddf27f890b5263c81b2a00537161446757ebe9cb109b9c923b1591992e04",
    );
    expect(Object.hasOwn(fresh, "uploadIntent")).toBe(false);
  });

  it("rejects invalid CLI authority before the recorder can run", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ios-reconcile-cli-"));
    const scripts = path.join(root, "scripts");
    const recorderSentinel = path.join(root, "recorder-called");
    const preloadSentinel = path.join(root, "preload-active");
    const preload = path.join(root, "preload.mjs");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(
      preload,
      [
        'import childProcess from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        `writeFileSync(${JSON.stringify(preloadSentinel)}, "active");`,
        "const original = childProcess.execFileSync;",
        "childProcess.execFileSync = function(file, args, options) {",
        '  if (args?.some((arg) => String(arg).endsWith("mobile-release-ref.ts"))) {',
        `    writeFileSync(${JSON.stringify(recorderSentinel)}, "called");`,
        "  }",
        "  return original.call(this, file, args, options);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(path.join(scripts, "tsx.mjs"), "", { mode: 0o600 });
    writeFileSync(path.join(scripts, "mobile-release-ref.ts"), "", { mode: 0o600 });

    try {
      const result = spawnSync(
        process.execPath,
        ["--import", preload, ...recordArgs(root, workflowSha)],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, GITHUB_WORKSPACE: root },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Reconciliation input --target-sha mismatch");
      expect(existsSync(preloadSentinel)).toBe(true);
      expect(existsSync(recorderSentinel)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["bare", ".github/workflows/ios-beta-release.yml", ".github/workflows/ios-release.yml"],
    [
      "protected-main qualified",
      ".github/workflows/ios-beta-release.yml@refs/heads/main",
      ".github/workflows/ios-release.yml@refs/heads/main",
    ],
  ])("accepts %s workflow-run paths", (_name, originalPath, currentPath) => {
    const { recorderCalled, result } = runRecordAuthorityFixture({
      currentPath,
      originalPath,
    });
    expect(result.status).toBe(0);
    expect(recorderCalled).toBe(true);
  });

  it.each([
    [
      "original wrong ref",
      ".github/workflows/ios-beta-release.yml@refs/heads/release",
      ".github/workflows/ios-release.yml@refs/heads/main",
    ],
    [
      "current wrong workflow",
      ".github/workflows/ios-beta-release.yml@refs/heads/main",
      ".github/workflows/other.yml@refs/heads/main",
    ],
    [
      "original malformed suffix",
      ".github/workflows/ios-beta-release.yml@refs/heads/main@unexpected",
      ".github/workflows/ios-release.yml@refs/heads/main",
    ],
    [
      "current malformed suffix",
      ".github/workflows/ios-beta-release.yml@refs/heads/main",
      ".github/workflows/ios-release.yml@refs/heads/main@unexpected",
    ],
  ])("rejects %s before the recorder can run", (_name, originalPath, currentPath) => {
    const { recorderCalled, result } = runRecordAuthorityFixture({
      currentPath,
      originalPath,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Workflow run path mismatch");
    expect(recorderCalled).toBe(false);
  });

  it("rechecks evidence freshness after remote authority reads before recording", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ios-reconcile-freshness-"));
    const scripts = path.join(root, "scripts");
    const recorderSentinel = path.join(root, "recorder-called");
    const preload = path.join(root, "preload.mjs");
    const originalWorkflowSha = originalReceipt.workflowSha;
    const currentRunId = "40000000000";
    mkdirSync(scripts, { recursive: true });
    writeFileSync(path.join(root, "receipt.json"), originalReceiptBytes, { mode: 0o600 });
    writeFileSync(path.join(root, "evidence.json"), canonicalBytes(evidence()), { mode: 0o600 });
    writeFileSync(path.join(scripts, "tsx.mjs"), "", { mode: 0o600 });
    writeFileSync(path.join(scripts, "mobile-release-ref.ts"), "", { mode: 0o600 });
    writeFileSync(
      preload,
      [
        'import childProcess from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "let remoteRead = false;",
        `const freshNow = ${Date.parse("2026-09-26T18:10:00.000Z")};`,
        `const staleNow = ${Date.parse("2026-09-26T18:30:00.001Z")};`,
        "Date.now = () => remoteRead ? staleNow : freshNow;",
        "const originalExec = childProcess.execFileSync;",
        "const originalSpawn = childProcess.spawnSync;",
        "const responses = new Map([",
        `  ["repos/openclaw/openclaw/actions/artifacts/10130298326", ${JSON.stringify({
          expired: false,
          id: 10130298326,
          name: "mobile-release-ref-ios-34419244851-1",
          workflow_run: { head_sha: originalWorkflowSha, id: 34419244851 },
        })}],`,
        `  ["repos/openclaw/openclaw/actions/runs/34419244851", ${JSON.stringify({
          actor: { login: "vincentkoc" },
          conclusion: "failure",
          event: "workflow_dispatch",
          head_sha: originalWorkflowSha,
          path: ".github/workflows/ios-beta-release.yml@refs/heads/main",
          run_attempt: 1,
          status: "completed",
          triggering_actor: { login: "vincentkoc" },
        })}],`,
        `  ["repos/openclaw/openclaw/actions/jobs/102691169741", ${JSON.stringify({
          completed_at: "2026-09-10T01:40:28Z",
          conclusion: "failure",
          head_sha: originalWorkflowSha,
          name: "Upload and record iOS beta",
          run_attempt: 1,
          run_id: 34419244851,
          started_at: "2026-09-10T00:04:43Z",
          status: "completed",
        })}],`,
        '  ["repos/openclaw/openclaw/collaborators/vincentkoc/permission", {"permission":"maintain"}],',
        `  ["repos/openclaw/openclaw/actions/artifacts/20000000000", ${JSON.stringify({
          digest: `sha256:${"a".repeat(64)}`,
          expired: false,
          id: 20000000000,
          name: `ios-release-reconciliation-${currentRunId}-1`,
          workflow_run: { head_sha: workflowSha, id: Number(currentRunId) },
        })}],`,
        `  ["repos/openclaw/openclaw/actions/runs/${currentRunId}", ${JSON.stringify({
          actor: { login: "vincentkoc" },
          conclusion: null,
          event: "workflow_dispatch",
          head_sha: workflowSha,
          path: ".github/workflows/ios-release.yml@refs/heads/main",
          run_attempt: 1,
          status: "in_progress",
          triggering_actor: { login: "vincentkoc" },
        })}],`,
        "]);",
        "childProcess.execFileSync = function(file, args, options) {",
        '  if (file === "gh") {',
        "    remoteRead = true;",
        "    const response = responses.get(args?.[1]);",
        "    if (!response) throw new Error(`unexpected gh endpoint: ${args?.[1]}`);",
        "    return JSON.stringify(response);",
        "  }",
        '  if (args?.some((arg) => String(arg).endsWith("mobile-release-ref.ts"))) {',
        `    writeFileSync(${JSON.stringify(recorderSentinel)}, "called");`,
        "  }",
        "  return originalExec.call(this, file, args, options);",
        "};",
        "childProcess.spawnSync = function(file, args, options) {",
        '  if (file === "git") {',
        "    remoteRead = true;",
        "    const ref = args?.at(-1);",
        '    if (ref === "refs/heads/release/2026.9.2-mobile") {',
        `      return { error: undefined, signal: null, status: 0, stderr: "", stdout: ${JSON.stringify(
          `${candidate}\trefs/heads/release/2026.9.2-mobile\n`,
        )} };`,
        "    }",
        '    if (ref === "refs/openclaw/mobile-releases/ios/2026.9.20-1") {',
        '      return { error: undefined, signal: null, status: 2, stderr: "", stdout: "" };',
        "    }",
        "    throw new Error(`unexpected git ref: ${ref}`);",
        "  }",
        "  return originalSpawn.call(this, file, args, options);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    try {
      const result = spawnSync(process.execPath, ["--import", preload, ...recordArgs(root)], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTOR: "vincentkoc",
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: currentRunId,
          GITHUB_TRIGGERING_ACTOR: "vincentkoc",
          GITHUB_WORKFLOW_REF:
            "openclaw/openclaw/.github/workflows/ios-release.yml@refs/heads/main",
          GITHUB_WORKFLOW_SHA: workflowSha,
          GITHUB_WORKSPACE: root,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Reconciliation evidence is stale");
      expect(existsSync(recorderSentinel)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
