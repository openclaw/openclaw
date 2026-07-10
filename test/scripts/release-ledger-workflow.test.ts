import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/release-ledger.yml";
const CHECKOUT_V6 = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const SETUP_NODE_V6 = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  ["working-directory"]?: string;
};

type WorkflowJob = {
  environment?: string;
  name?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  ["timeout-minutes"]?: number;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  on?: {
    push?: unknown;
    workflow_call?: unknown;
    workflow_dispatch?: {
      inputs?: Record<string, { default?: boolean | string; required?: boolean; type?: string }>;
    };
  };
  permissions?: Record<string, string>;
};

function workflow(): Workflow {
  return parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function job(parsed: Workflow): WorkflowJob {
  const found = parsed.jobs.generate_release_ledger;
  expect(found).toBeDefined();
  return found;
}

function step(parsedJob: WorkflowJob, name: string): WorkflowStep {
  const found = parsedJob.steps?.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

function nodeHeredocs(run: string): string[] {
  return [
    ...run.matchAll(/node --input-type=module <<'NODE'\n(?<body>[\s\S]*?)\nNODE(?:\n|$)/gu),
  ].map((match) => {
    if (!match.groups?.body) {
      throw new Error("Missing embedded Node module heredoc");
    }
    return match.groups.body;
  });
}

describe("release ledger producer workflow", () => {
  it("is manual, trusted-main only, read-only, and attempt-1 only", () => {
    const parsed = workflow();
    const raw = readFileSync(WORKFLOW_PATH, "utf8");
    expect(parsed.on?.push).toBeUndefined();
    expect(parsed.on?.workflow_call).toBeUndefined();
    expect(parsed.on?.workflow_dispatch?.inputs).toMatchObject({
      base_ref: { required: true, type: "string" },
      provenance_json: { required: true, type: "string" },
      release_ref: { required: true, type: "string" },
      release_sha: { required: true, type: "string" },
      shipped_refs_json: { default: "[]", required: true, type: "string" },
      source_sha: { required: true, type: "string" },
      version: { required: true, type: "string" },
    });
    expect(
      JSON.parse(String(parsed.on?.workflow_dispatch?.inputs?.provenance_json?.default)),
    ).toEqual({
      adaptedPullRequests: [],
      comparisonPullRequestMemberOverlaps: [],
      integratedPullRequests: [],
      partialPullRequests: [],
      pullRequests: [],
      refs: [],
    });
    expect(Object.keys(parsed.on?.workflow_dispatch?.inputs ?? {})).toHaveLength(7);
    expect(parsed.permissions).toEqual({
      actions: "read",
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    });
    expect(raw).not.toContain("id-token:");
    expect(raw).not.toContain("packages: write");
    expect(raw).not.toContain("contents: write");
    expect(raw).not.toContain("npm publish");
    expect(raw).not.toContain("gh release");

    const producer = job(parsed);
    expect(producer.name).toBe("Generate release ledger");
    expect(producer.environment).toBeUndefined();
    expect(producer["timeout-minutes"]).toBe(120);
    const authorization = step(producer, "Authorize trusted dispatch");
    expect(authorization.env).toEqual({
      RUN_ATTEMPT: "${{ github.run_attempt }}",
      WORKFLOW_REF: "${{ github.ref }}",
      WORKFLOW_REF_IDENTITY: "${{ github.workflow_ref }}",
      WORKFLOW_REPOSITORY: "${{ github.repository }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(authorization.run).toContain('[[ "$RUN_ATTEMPT" == "1" ]]');
    expect(authorization.run).toContain('[[ "$WORKFLOW_REF" == "refs/heads/main" ]]');
    expect(authorization.run).toContain(
      '[[ "$WORKFLOW_REF_IDENTITY" == "openclaw/openclaw/.github/workflows/release-ledger.yml@refs/heads/main" ]]',
    );
    expect(authorization.run).toContain('[[ "$WORKFLOW_REPOSITORY" == "openclaw/openclaw" ]]');

    const guard = step(producer, "Validate trusted workflow and release refs");
    expect(guard.env).toMatchObject({
      RUN_ATTEMPT: "${{ github.run_attempt }}",
      WORKFLOW_REF: "${{ github.ref }}",
      WORKFLOW_REF_IDENTITY: "${{ github.workflow_ref }}",
      WORKFLOW_REPOSITORY: "${{ github.repository }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(guard.run).toContain('[[ "$RUN_ATTEMPT" == "1" ]]');
    expect(guard.run).toContain('[[ "$WORKFLOW_REF" == "refs/heads/main" ]]');
    expect(guard.run).toContain('[[ "$WORKFLOW_REPOSITORY" == "openclaw/openclaw" ]]');
    expect(guard.run).toContain('git merge-base --is-ancestor "$WORKFLOW_SHA"');
  });

  it("separates trusted tooling from the detached exact release candidate", () => {
    const producer = job(workflow());
    expect(step(producer, "Checkout trusted main tooling")).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        "fetch-depth": 0,
        "fetch-tags": true,
        "persist-credentials": false,
        ref: "${{ github.sha }}",
      },
    });
    expect(step(producer, "Checkout exact release candidate")).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        clean: true,
        "fetch-depth": 0,
        "fetch-tags": true,
        path: ".release-candidate",
        "persist-credentials": false,
        ref: "${{ inputs.release_sha }}",
      },
    });
    expect(step(producer, "Setup Node")).toMatchObject({
      uses: SETUP_NODE_V6,
      with: { "node-version": "${{ env.NODE_VERSION }}" },
    });
    const ghx = step(producer, "Provide trusted ghx compatibility shim");
    expect(ghx.run).toContain('gh_path="$(command -v gh)"');
    expect(ghx.run).toContain('ln -s "$gh_path" "$shim_dir/ghx"');
    expect(ghx.run).toContain('echo "$shim_dir" >> "$GITHUB_PATH"');

    const refs = step(producer, "Validate trusted workflow and release refs");
    expect(refs.run).toContain(
      "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main",
    );
    expect(refs.run).toContain('"+refs/heads/${RELEASE_REF}:refs/remotes/origin/${RELEASE_REF}"');
    expect(refs.run).toContain('release_tip="$(git rev-parse --verify');
    expect(refs.run).toContain('[[ "$release_tip" == "$RELEASE_SHA" ]]');
    expect(refs.run).toContain('[[ "$(git rev-parse --is-shallow-repository)" == "false" ]]');
    expect(refs.run).toContain("refs/replace");
    expect(refs.run).toContain(
      '"+refs/pull/${number}/head:refs/remotes/origin/pull/${number}/head"',
    );
    expect(refs.run).toContain('git cat-file -e "${commit}^{commit}"');
    expect(refs.run).toContain('git fetch --force --no-tags origin "$commit"');
    expect(refs.run).toContain("Provenance commit did not resolve exactly");
  });

  it("runs the landed verifier with a closed, immutable schema-v6 invocation", () => {
    const producer = job(workflow());
    const ledger = step(producer, "Generate and validate schema-v6 ledger");
    expect(ledger["working-directory"]).toBe(".release-candidate");
    expect(ledger.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      RELEASE_SHA: "${{ inputs.release_sha }}",
      SOURCE_SHA: "${{ inputs.source_sha }}",
      TOOLING_COMMIT: "${{ steps.refs.outputs.tooling_commit }}",
      TOOLING_TREE: "${{ steps.refs.outputs.tooling_tree }}",
    });
    const run = ledger.run ?? "";
    for (const flag of [
      '"--comparison-base"',
      '"--comparison-pr-member-overlap"',
      '"--manifest"',
      '"--max-changelog-tail"',
      '"--provenance-pr"',
      '"--provenance-pr-adapted"',
      '"--provenance-pr-integrated"',
      '"--provenance-pr-partial"',
      '"--shipped-ref"',
      '"--source-target"',
      '"--tooling-commit"',
      '"--tooling-tree"',
      '"--write-ledger"',
    ]) {
      expect(run).toContain(flag);
    }
    expect(run).not.toContain('"--seed-ref"');
    expect(run).not.toContain('"--check-github"');
    expect(run).toContain("manifest.schemaVersion === 6");
    expect(run).toContain('manifest.status === "pass"');
    expect(run).toContain("manifest.target === sourceSha");
    expect(run).toContain("manifest.finalTarget === releaseSha");
    expect(run).toContain("const maxChangelogTail = 1");
    expect(run).toContain("const shippedRefs = [base, ...additionalShippedRefs].toSorted()");
    expect(run).toContain("manifest.seedAuthorization === null");
    expect(run).toContain(
      "JSON.stringify(manifest.invocation) === JSON.stringify(expectedInvocation)",
    );
    expect(run).toContain("inventoryDigest === sha256");
    expect(run).toContain("manifest.inventory?.schemaVersion === 4");
    expect(run).toContain("referenceEntries.sha256 ===");
    expect(run).toContain("manifest.source.references === referenceEntries.count");
    expect(run).toContain("manifest.source.pullRequests === manifestPullRequests.length");
    expect(run).toContain("manifest.source.issues ===");
    expect(run).toContain("manifest.artifacts?.changelogSha256 === changelogSha256");
    expect(run).toContain("manifest.artifacts?.releaseSectionSha256 === sha256(releaseSection)");
    expect(run).toContain('env: { ...gitEnv, NO_COLOR: "1" }');
    expect(run).toContain('git("status", "--porcelain=v1", "--untracked-files=no") === ""');
    expect(run).toContain('["publicationAuthority", "false"]');
  });

  it("accepts only stable and correction changelog headings", () => {
    const run = step(job(workflow()), "Generate and validate schema-v6 ledger").run ?? "";
    const source = run.match(/const versionPattern = \/(?<source>[^/]+)\/u;/u)?.groups?.source;
    expect(source).toBeDefined();
    const versionPattern = new RegExp(source!, "u");
    expect(versionPattern.test("2026.7.1")).toBe(true);
    expect(versionPattern.test("2026.7.1-1")).toBe(true);
    expect(versionPattern.test("2026.7.1-01")).toBe(false);
    expect(versionPattern.test("2026.7.1-beta.3")).toBe(false);
    expect(versionPattern.test("2026.7.1-alpha.1")).toBe(false);
  });

  it("keeps every embedded Node module syntactically valid", () => {
    const producer = job(workflow());
    const modules = (producer.steps ?? []).flatMap((candidate) =>
      nodeHeredocs(candidate.run ?? ""),
    );
    expect(modules.length).toBeGreaterThanOrEqual(3);
    for (const module of modules) {
      const syntax = spawnSync(process.execPath, ["--check", "--input-type=module", "-"], {
        encoding: "utf8",
        input: module,
      });
      expect(syntax.status, syntax.stderr).toBe(0);
    }
  });

  it("uploads one stable immutable artifact and exposes its identity without publication authority", () => {
    const producer = job(workflow());
    expect(producer.outputs).toMatchObject({
      artifact_digest: "${{ steps.upload.outputs.artifact-digest }}",
      artifact_id: "${{ steps.upload.outputs.artifact-id }}",
      artifact_member: "${{ steps.ledger.outputs.artifact_member }}",
      artifact_name: "${{ steps.ledger.outputs.artifact_name }}",
      artifact_size_bytes: "${{ steps.artifact.outputs.artifact_size_bytes }}",
      artifact_url: "${{ steps.upload.outputs.artifact-url }}",
      manifest_bytes: "${{ steps.ledger.outputs.manifest_bytes }}",
      manifest_sha256: "${{ steps.ledger.outputs.manifest_sha256 }}",
      publicationAuthority: "${{ steps.ledger.outputs.publicationAuthority }}",
      release_ref: "${{ inputs.release_ref }}",
      release_sha: "${{ steps.ledger.outputs.release_sha }}",
      repository: "${{ github.repository }}",
      run_attempt: "${{ github.run_attempt }}",
      run_id: "${{ github.run_id }}",
      source_sha: "${{ steps.ledger.outputs.source_sha }}",
      tooling_commit: "${{ steps.ledger.outputs.tooling_commit }}",
      tooling_tree: "${{ steps.ledger.outputs.tooling_tree }}",
      workflow_path: ".github/workflows/release-ledger.yml",
      workflow_ref: "${{ github.workflow_ref }}",
      workflow_sha: "${{ github.workflow_sha }}",
    });

    const revalidate = step(producer, "Revalidate live release ref");
    expect(revalidate["working-directory"]).toBe(".release-candidate");
    expect(revalidate.run).toContain("Live $RELEASE_REF moved");
    expect(revalidate.run).toContain(
      '[[ -z "$(git status --porcelain=v1 --untracked-files=no)" ]]',
    );

    const upload = step(producer, "Upload immutable ledger evidence");
    expect(upload.uses).toBe(UPLOAD_ARTIFACT_V7);
    expect(upload.with).toEqual({
      "compression-level": 0,
      "if-no-files-found": "error",
      "include-hidden-files": true,
      name: "release-ledger-evidence",
      overwrite: false,
      path: ".local/release-ledger-manifest.json",
      "retention-days": 90,
    });
    const artifact = step(producer, "Bind uploaded artifact metadata");
    expect(artifact.env).toMatchObject({
      ARTIFACT_DIGEST: "${{ steps.upload.outputs.artifact-digest }}",
      ARTIFACT_ID: "${{ steps.upload.outputs.artifact-id }}",
      ARTIFACT_NAME: "${{ steps.ledger.outputs.artifact_name }}",
      RUN_ID: "${{ github.run_id }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(artifact.run).toContain('node --input-type=module - "$metadata"');
    expect(artifact.run).toContain("artifact_size_bytes=");
    const summary = step(producer, "Summarize ledger evidence");
    expect(summary.run).toContain("Publication authority: false");
    expect(summary.run).toContain("release-ledger-evidence");
  });
});
