import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/openclaw-npm-release.yml";

type Step = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  "working-directory"?: string;
};
type Job = {
  environment?: string;
  if?: string;
  needs?: string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: {
        bypass_extended_stable_guard?: { default?: boolean; type?: string };
        npm_dist_tag?: { options?: string[] };
        plugin_npm_run_id?: { required?: boolean; type?: string };
      };
    };
  };
  jobs?: Record<string, Job>;
};

function workflow(): Workflow {
  return parse(readFileSync(workflowPath, "utf8")) as Workflow;
}

function step(job: Job | undefined, name: string): Step {
  const found = job?.steps?.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return found;
}

describe("minimal npm extended-stable workflow", () => {
  it("adds extended-stable without adding policy or verifier contracts", () => {
    const raw = readFileSync(workflowPath, "utf8");
    const parsed = workflow();
    expect(parsed.on?.workflow_dispatch?.inputs?.npm_dist_tag?.options).toEqual([
      "alpha",
      "beta",
      "latest",
      "extended-stable",
    ]);
    for (const forbidden of [
      "release-policy",
      "policyMode",
      "release-operation-verifier",
      "release_delta_contract",
      "delta evidence",
      "external_contract_revision",
      "stable-lines.json",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("reuses the v1 preflight tarball and guards all three extended-stable gates", () => {
    const parsed = workflow();
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw).toContain("version: 1");
    expect(raw).toContain("openclaw-npm-preflight-${{ inputs.tag }}");
    const preflight = parsed.jobs?.preflight_openclaw_npm;
    const validate = parsed.jobs?.validate_publish_request;
    const publish = parsed.jobs?.publish_openclaw_npm;
    const requestValidationSteps = [
      step(preflight, "Validate npm release request"),
      step(validate, "Validate npm release request"),
      step(publish, "Recheck npm release request"),
    ];
    for (const requestValidation of requestValidationSteps) {
      expect(requestValidation.run).toContain("openclaw-npm-extended-stable-release.mjs");
      expect(requestValidation.run).toContain("validate-request");
    }
    expect(step(preflight, "Validate npm release request").env?.PREFLIGHT_ONLY).toBe(
      "${{ inputs.preflight_only }}",
    );
    expect(validate?.steps?.map((candidate) => candidate.name)).not.toContain(
      "Setup Node environment",
    );
  });

  it("threads an explicit, default-off extended-stable bypass through every policy gate", () => {
    const parsed = workflow();
    const input = parsed.on?.workflow_dispatch?.inputs?.bypass_extended_stable_guard;
    expect(input).toMatchObject({ default: false, type: "boolean" });

    const policySteps = [
      step(parsed.jobs?.preflight_openclaw_npm, "Validate npm release request"),
      step(parsed.jobs?.validate_publish_request, "Validate npm release request"),
      step(parsed.jobs?.publish_openclaw_npm, "Recheck npm release request"),
      step(parsed.jobs?.publish_openclaw_npm, "Publish"),
    ];
    for (const policyStep of policySteps) {
      expect(policyStep.env?.BYPASS_EXTENDED_STABLE_GUARD).toBe(
        "${{ inputs.bypass_extended_stable_guard }}",
      );
    }
    const trustedRef = step(
      parsed.jobs?.validate_publish_request,
      "Require trusted workflow ref for publish",
    );
    expect(trustedRef.env?.BYPASS_EXTENDED_STABLE_GUARD).toBeUndefined();
    expect(trustedRef.run).not.toContain("BYPASS_EXTENDED_STABLE_GUARD");
    expect(trustedRef.run).toContain('"${WORKFLOW_REF}" == refs/heads/extended-stable/*');

    const summary = step(parsed.jobs?.verify_openclaw_npm, "Summarize npm publication");
    expect(summary.env?.BYPASS_EXTENDED_STABLE_GUARD).toBe(
      "${{ inputs.bypass_extended_stable_guard }}",
    );
    expect(summary.run).toContain("Extended-stable guard bypass: ${BYPASS_EXTENDED_STABLE_GUARD}");
  });

  it("accepts arbitrary SHA preflight targets and exercises every publishable plugin package", () => {
    const parsed = workflow();
    const preflight = parsed.jobs?.preflight_openclaw_npm;
    const metadata = step(preflight, "Validate release metadata");
    expect(metadata.run).toContain('RELEASE_BRANCH_REF="${RELEASE_SHA}"');
    expect(metadata.run).not.toContain("Validation-only SHA mode only supports");

    const plugins = step(preflight, "Exercise all extended-stable plugin npm packages");
    expect(step(preflight, "Verify release contents").env).toMatchObject({
      OPENCLAW_RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR:
        "${{ steps.ai_runtime_tarballs.outputs.dir }}",
    });
    expect(plugins.if).toBe("${{ inputs.npm_dist_tag == 'extended-stable' }}");
    expect(plugins.env).toMatchObject({
      OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: "extended-stable",
    });
    expect(plugins.run).toContain("--selection-mode all-publishable");
    expect(plugins.run).toContain("--npm-dist-tag extended-stable");
    expect(plugins.run).toContain("scripts/check-plugin-npm-runtime-builds.mjs");
    expect(plugins.run).toContain("scripts/plugin-npm-publish.sh --pack");
    expect(plugins.run).toContain("OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR");
    expect(plugins.run).not.toContain("--publish");
    expect(step(preflight, "Upload extended-stable plugin npm packages")).toBeDefined();
  });

  it("restores same-SHA preflight build outputs and keeps validation steps running", () => {
    const parsed = workflow();
    const preflight = parsed.jobs?.preflight_openclaw_npm;

    const restore = step(preflight, "Restore preflight build outputs");
    expect(restore.uses).toContain("actions/cache/restore@");
    expect(restore.with?.key).toBe(
      "${{ runner.os }}-npm-preflight-dist-v1-${{ steps.preflight_cache_key.outputs.sha }}-${{ hashFiles('pnpm-lock.yaml') }}",
    );

    // Only the build producers skip on a cache hit; every validation step
    // still runs against the restored artifacts.
    expect(step(preflight, "Build").if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(step(preflight, "Build Control UI").if).toBe(
      "steps.dist_build_cache.outputs.cache-hit != 'true'",
    );
    expect(step(preflight, "Check").if).toBeUndefined();
    expect(step(preflight, "Verify release contents").if).toBeUndefined();
    expect(step(preflight, "Verify prepared npm tarball install").if).toBeUndefined();

    const save = step(preflight, "Save preflight build outputs");
    expect(save.uses).toContain("actions/cache/save@");
    expect(save.with?.key).toBe("${{ steps.dist_build_cache.outputs.cache-primary-key }}");
  });

  it("authenticates exact extended-stable run and Full Validation identities", () => {
    const parsed = workflow();
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw).toContain("--json workflowName,headBranch,headSha,event,conclusion,url");
    const fullValidationRun = step(
      parsed.jobs?.publish_openclaw_npm,
      "Verify full release validation run metadata",
    );
    expect(fullValidationRun.env?.FULL_RELEASE_VALIDATION_RUN_ATTEMPT).toBe(
      "${{ inputs.full_release_validation_run_attempt }}",
    );
    expect(fullValidationRun.run).toContain(
      "actions/runs/${FULL_RELEASE_VALIDATION_RUN_ID}/attempts/${FULL_RELEASE_VALIDATION_RUN_ATTEMPT}",
    );
    expect(fullValidationRun.run).toContain(
      '"$run_attempt" != "$FULL_RELEASE_VALIDATION_RUN_ATTEMPT"',
    );
    expect(fullValidationRun.run).toContain('echo "attempt=$run_attempt" >> "$GITHUB_OUTPUT"');
    expect(raw.match(/openclaw-npm-extended-stable-release\.mjs verify-run/g)).toHaveLength(3);
    expect(raw).toContain("openclaw-npm-extended-stable-release.mjs verify-manifest");
  });

  it("requires fresh full validation and binds both exact npm artifacts before mutation", () => {
    const parsed = workflow();
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw).not.toMatch(/release[_ -]delta/iu);

    const promotion = step(
      parsed.jobs?.validate_publish_request,
      "Require preflight artifact promotion on real publish",
    );
    expect(promotion.run).toContain(
      "Real publish requires full_release_validation_run_id from a successful Full Release Validation run.",
    );
    expect(promotion.run).not.toContain(
      "::warning::Beta publish is proceeding from npm preflight only",
    );

    const publish = parsed.jobs?.publish_openclaw_npm;
    const download = step(publish, "Download prepared npm tarball");
    expect(download.if).toBeUndefined();

    const provenance = step(publish, "Verify prepared tarball provenance");
    expect(provenance.run).toContain(".dependencyTarballs[0].tarballName");
    expect(provenance.run).toContain("printf 'ai_tarball_path=%s");
    expect(provenance.run).toContain('[[ ! "$ARTIFACT_TARBALL_NAME" =~ ^openclaw-[0-9A-Za-z]');
    expect(provenance.run).toContain('"$ARTIFACT_PACKAGE_NAME" != "openclaw"');
    expect(provenance.run).toContain('"$ai_package_name" != "@openclaw/ai"');
    expect(provenance.run).toContain("manifest_sha256=");
    expect(provenance.run).toContain("ai_tarball_sha256=");
    expect(provenance.run).toContain("root_npm_integrity=");
    expect(provenance.run).toContain("ai_npm_integrity=");

    const mutation = step(publish, "Publish");
    const syntax = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: mutation.run ?? "",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(mutation.run).toContain("recheck_publish_inputs");
    expect(mutation.run).toContain("Trusted npm tooling or inert release target changed");
    expect(mutation.run).toContain("Prepared npm package bytes changed before npm mutation.");
    expect(mutation.run).toContain("resolveNpmPublicationReadinessFromRegistry");
    expect(mutation.run).toContain('OPENCLAW_NPM_EXPECTED_PACKAGE_NAME="$package_name"');
    expect(mutation.run).toContain('bash "$TRUSTED_PUBLISH_SCRIPT" --validate "$tarball_path"');
    expect(mutation.run).toContain("Pre-mutation npm state:");
    expect(mutation.env).toMatchObject({
      EXPECTED_AI_TARBALL_SHA256: "${{ steps.preflight_provenance.outputs.ai_tarball_sha256 }}",
      EXPECTED_MANIFEST_SHA256: "${{ steps.preflight_provenance.outputs.manifest_sha256 }}",
      EXPECTED_ROOT_TARBALL_SHA256: "${{ steps.preflight_provenance.outputs.tarball_sha256 }}",
    });
    const mutationScript = mutation.run ?? "";
    const helperStart = mutationScript.indexOf("publish_if_missing() {");
    const helperValidation = mutationScript.indexOf(
      'validate_publish_target "$package_name" "$tarball_path" "$expected_sha256"',
      helperStart,
    );
    const helperState = mutationScript.indexOf(
      'state="$(publication_state "$package_name" "$expected_integrity" "$expected_shasum")"',
      helperValidation,
    );
    const helperPublish = mutationScript.indexOf(
      'bash "$TRUSTED_PUBLISH_SCRIPT" --publish "$tarball_path"',
      helperState,
    );
    const preMutationMarker = mutationScript.indexOf(
      "# npm cannot publish two packages transactionally.",
      helperPublish,
    );
    const firstPublishCall = mutationScript.indexOf("publish_if_missing \\", preMutationMarker);
    const preMutation = mutationScript.slice(preMutationMarker, firstPublishCall);
    const aiPublish = mutationScript.indexOf('"@openclaw/ai"', firstPublishCall);
    const rootPublish = mutationScript.indexOf('"openclaw"', aiPublish + 1);
    expect(helperValidation).toBeGreaterThan(helperStart);
    expect(helperState).toBeGreaterThan(helperValidation);
    expect(helperPublish).toBeGreaterThan(helperState);
    expect(preMutationMarker).toBeGreaterThan(helperPublish);
    expect(preMutation).toMatch(/validate_publish_target \\\n\s+"openclaw"/u);
    expect(preMutation).toMatch(/validate_publish_target \\\n\s+"@openclaw\/ai"/u);
    expect(preMutation).toMatch(/publication_state \\\n\s+"openclaw"/u);
    expect(preMutation).toMatch(/publication_state \\\n\s+"@openclaw\/ai"/u);
    expect(aiPublish).toBeGreaterThan(helperPublish);
    expect(rootPublish).toBeGreaterThan(aiPublish);
    expect(mutationScript.slice(aiPublish, rootPublish)).toContain('"$EXPECTED_AI_NPM_INTEGRITY"');
    expect(mutationScript.slice(rootPublish)).toContain('"$EXPECTED_ROOT_NPM_INTEGRITY"');
  });

  it("keeps the release target inert and all executable tooling pinned to the workflow SHA", () => {
    const parsed = workflow();
    const publish = parsed.jobs?.publish_openclaw_npm;
    const trustedCheckout = step(publish, "Checkout trusted npm release tooling");
    expect(trustedCheckout.with).toMatchObject({
      repository: "${{ fromJSON(toJSON(job)).workflow_repository }}",
      ref: "${{ fromJSON(toJSON(job)).workflow_sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    });

    const targetCheckout = step(publish, "Checkout inert release target");
    expect(targetCheckout.with).toMatchObject({
      ref: "refs/tags/${{ inputs.tag }}",
      path: ".release-target",
      "fetch-depth": 0,
      "persist-credentials": false,
      "sparse-checkout": "package.json",
      "sparse-checkout-cone-mode": false,
    });
    const targetIdentity = step(publish, "Resolve inert release target identity");
    expect(targetIdentity.env).toMatchObject({
      TARGET_ROOT: "${{ github.workspace }}/.release-target",
      TRUSTED_WORKFLOW_SHA: "${{ fromJSON(toJSON(job)).workflow_sha }}",
    });
    expect(targetIdentity.run).toContain('"$RELEASE_TAG" != "v${target_version}"');
    expect(targetIdentity.run).toContain('echo "sha=$target_sha"');
    expect(targetIdentity.run).toContain('echo "version=$target_version"');

    const recheck = step(publish, "Recheck npm release request");
    expect(recheck["working-directory"]).toBe(".release-target");
    expect(recheck.run).toBe(
      'node "$GITHUB_WORKSPACE/scripts/openclaw-npm-extended-stable-release.mjs" validate-request',
    );
    const mutation = step(publish, "Publish");
    expect(mutation.env).toMatchObject({
      TARGET_ROOT: "${{ github.workspace }}/.release-target",
      TRUSTED_PUBLISH_SCRIPT: "${{ github.workspace }}/scripts/openclaw-npm-publish.sh",
    });
    expect(mutation.run).toContain('cd "$TARGET_ROOT"');
    expect(mutation.run).toContain('bash "$TRUSTED_PUBLISH_SCRIPT"');
    expect(mutation.run).not.toContain("bash .release-target/");
    expect(mutation.run).not.toContain("node .release-target/");
    for (const candidate of publish?.steps ?? []) {
      expect(candidate.uses ?? "", candidate.name).not.toContain(".release-target/");
      expect(candidate.run ?? "", candidate.name).not.toMatch(
        /(?:bash|node|pnpm)\s+["']?\.release-target\//u,
      );
    }
  });

  it("requires and authenticates the plugin npm run before an extended-stable core publish", () => {
    const parsed = workflow();
    expect(parsed.on?.workflow_dispatch?.inputs?.plugin_npm_run_id).toMatchObject({
      required: false,
      type: "string",
    });
    const required = step(
      parsed.jobs?.validate_publish_request,
      "Require preflight artifact promotion on real publish",
    );
    expect(required.env?.PLUGIN_NPM_RUN_ID).toBe("${{ inputs.plugin_npm_run_id }}");
    expect(required.run).toContain("Extended-stable publish requires plugin_npm_run_id");

    const verify = step(
      parsed.jobs?.publish_openclaw_npm,
      "Verify plugin npm release run metadata",
    );
    expect(verify.env?.RUN_KIND).toBe("plugin");
    expect(verify.run).toContain(
      "--json workflowName,displayTitle,headBranch,headSha,event,status,conclusion,url",
    );
    expect(verify.run).toContain("openclaw-npm-extended-stable-release.mjs verify-run");
  });

  it("captures selector fail closed, publishes extended-stable, retries, and summarizes", () => {
    const parsed = workflow();
    const publish = parsed.jobs?.publish_openclaw_npm;
    const verify = parsed.jobs?.verify_openclaw_npm;
    const capture = step(publish, "Capture previous extended-stable selector");
    const readback = step(verify, "Verify published npm artifact identities");
    const summary = step(verify, "Summarize npm publication");
    expect(capture.run).toContain("openclaw-npm-extended-stable-release.mjs capture-selector");
    expect(step(publish, "Publish").run).toContain("openclaw-npm-publish.sh");
    expect(readback.run).toContain("verifyPublishedNpmArtifactIdentities");
    expect(verify?.if).toContain("needs.publish_openclaw_npm.result == 'success'");
    expect(summary.run).toContain("openclaw-npm-extended-stable-release.mjs repair-command");
    expect(summary.run).toContain('EXPECTED_VERSION="$RELEASE_TAG"');
    expect(publish?.environment).toBe("npm-release");
    expect(verify?.environment).toBeUndefined();
    expect(verify?.permissions).toEqual({ contents: "read" });
    expect(verify?.permissions?.["id-token"]).toBeUndefined();
  });

  it("runs postpublish package and runtime verification without the npm release environment", () => {
    const verify = workflow().jobs?.verify_openclaw_npm;
    expect(verify?.needs).toEqual(["publish_openclaw_npm"]);
    expect(verify?.environment).toBeUndefined();
    expect(verify?.permissions).toEqual({ contents: "read" });
    const trustedCheckout = step(verify, "Checkout trusted npm postpublish verifier");
    expect(trustedCheckout.with?.ref).toBe("${{ fromJSON(toJSON(job)).workflow_sha }}");
    const identity = step(verify, "Verify published npm artifact identities");
    expect(identity.env).toMatchObject({
      PACKAGE_VERSION: "${{ needs.publish_openclaw_npm.outputs.package_version }}",
      RELEASE_SHA: "${{ needs.publish_openclaw_npm.outputs.release_sha }}",
      ROOT_NPM_INTEGRITY: "${{ needs.publish_openclaw_npm.outputs.root_npm_integrity }}",
      AI_NPM_INTEGRITY: "${{ needs.publish_openclaw_npm.outputs.ai_npm_integrity }}",
    });
    expect(identity.run).toContain("fetchNpmRegistryPackumentWithRetry");
    expect(identity.run).toContain("verifyPublishedNpmArtifactIdentities");
    expect(identity.run).toContain("attempts: 3");
    const runtime = step(verify, "Verify published OpenClaw runtime");
    expect(runtime.if).toBe("${{ inputs.npm_dist_tag != 'extended-stable' }}");
    expect(runtime.run).toContain("release:openclaw:npm:verify-published");
  });

  it("publishes only the tarball path verified from the preflight manifest", () => {
    const publish = workflow().jobs?.publish_openclaw_npm;
    const provenance = step(publish, "Verify prepared tarball provenance");
    const publishStep = step(publish, "Publish");
    expect(provenance.run).toContain(
      'ARTIFACT_TARBALL_PATH="preflight-tarball/$ARTIFACT_TARBALL_NAME"',
    );
    expect(provenance.run).toContain("printf 'tarball_path=%s");
    expect(publishStep.env?.PUBLISH_TARBALL_PATH).toBe(
      "${{ steps.preflight_provenance.outputs.tarball_path }}",
    );
    expect(publish?.steps?.map((candidate) => candidate.name)).not.toContain(
      "Resolve publish tarball",
    );
    expect(readFileSync(workflowPath, "utf8")).not.toContain(
      "find preflight-tarball -type f -name '*.tgz'",
    );
  });
});
