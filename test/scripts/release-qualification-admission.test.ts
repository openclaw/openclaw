import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  buildQualificationAdmissionRequest,
  resolveQualificationAdmissionDescriptor,
  revalidateQualificationAdmissionAuthority,
  semanticQualificationInputs,
  verifyQualificationAdmission,
  QUALIFICATION_ADMISSION_WORKFLOW,
} from "../../scripts/release-qualification-admission.mjs";
import {
  repository,
  candidateSha,
  publisherSha,
  transportRef,
  request,
  fixture,
} from "./release-qualification-admission.test-support.js";

describe("trusted P qualification admission", () => {
  it.each(["fresh", "upgrade", "direct", ""])("rejects narrowed cross-OS mode=%s", (mode) => {
    expect(() => fixture(false, { inputs: { mode } })).toThrow("requires mode=both");
  });

  it.each(['["extensions/codex/*.test.ts"]', "null", "{}"])(
    "rejects Node exclusions before producing admission: %s",
    (patterns) => {
      expect(() =>
        fixture(false, { inputs: { plugin_prerelease_node_exclude_patterns_json: patterns } }),
      ).toThrow("cannot exclude Plugin Prerelease Node tests");
    },
  );

  it.each(["stable", "full"])("rejects Telegram deferral for %s qualification", (profile) => {
    expect(() =>
      fixture(false, {
        inputs: { release_profile: profile, skip_package_telegram_e2e: "true" },
      }),
    ).toThrow("cannot skip Package Telegram E2E");
  });

  it.each(["npm:@openclaw/codex@latest", "npm:@openclaw/codex@2026.7.9", "./other-plugin.tgz"])(
    "rejects a Codex dependency override from candidate qualification: %s",
    (codex_plugin_spec) => {
      expect(() => fixture(false, { inputs: { codex_plugin_spec } })).toThrow("codex_plugin_spec");
    },
  );

  it("preserves beta Telegram deferral and unreleased Code-SHA qualification", () => {
    const f = fixture(false, {
      inputs: {
        skip_package_telegram_e2e: "true",
        allow_unreleased_changelog: "true",
        plugin_prerelease_node_exclude_patterns_json: "[ ]",
      },
    });
    expect(f.verify()).toEqual(f.receipt);
    expect(f.receipt.request.inputs.allow_unreleased_changelog).toBe("true");
  });

  it.each(["missing", "empty", "future", "omitted-support-floor", "altered-primary"])(
    "rejects %s qualification baselines without a registry fallback",
    (fault) => {
      const envelope = JSON.parse(
        expectDefined(request().inputs.trusted_workflow_json, "trusted workflow envelope"),
      );
      const baselines = JSON.parse(envelope.laneInputs.qualification_baselines_json);
      if (fault === "missing") {
        delete envelope.laneInputs.qualification_baselines_json;
      } else if (fault === "empty") {
        envelope.laneInputs.qualification_baselines_json = "";
      } else {
        if (fault === "future") {
          baselines.upgradeBaseline = "openclaw@2027.1.1";
          baselines.upgradeSurvivorBaselines = ["openclaw@2026.6.34", "openclaw@2027.1.1"];
        }
        if (fault === "omitted-support-floor") {
          baselines.upgradeSurvivorBaselines = ["openclaw@2026.7.8", "openclaw@2026.7.9"];
        }
        if (fault === "altered-primary") {
          baselines.upgradeBaseline = "openclaw@2026.7.8";
        }
        envelope.laneInputs.qualification_baselines_json = JSON.stringify(baselines);
      }
      expect(() =>
        fixture(false, { inputs: { trusted_workflow_json: JSON.stringify(envelope) } }),
      ).toThrow(/baseline|predecessor/i);
    },
  );

  it("binds baseline support to Q source data and rejects later evidence substitution", () => {
    expect(() => fixture(false, { candidateVersion: "2026.7.8" })).toThrow(/predecessor/);
    expect(() => fixture(false, { oldestSupportedBaseline: "2026.6.35" })).toThrow(
      /oldest-supported/,
    );
    const f = fixture();
    expect(f.receipt.baselinePolicy).toMatchObject({
      candidateVersion: "2026.8.1",
      oldestSupportedBaseline: "2026.6.34",
      packageSourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      policySourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const envelope = JSON.parse(
      expectDefined(f.selected.inputs.trusted_workflow_json, "trusted workflow envelope"),
    );
    envelope.laneInputs.qualification_baselines_json = JSON.stringify({
      upgradeBaseline: "openclaw@2026.7.8",
      upgradeSurvivorBaselines: ["openclaw@2026.6.34", "openclaw@2026.7.8"],
    });
    expect(() =>
      f.verify({ ...f.selected.inputs, trusted_workflow_json: JSON.stringify(envelope) }),
    ).toThrow(/authenticated operator request/);
  });
  it.each([false, true])(
    "authenticates exact P receipt without Q main ancestry (protected=%s)",
    (protectedTag) => {
      const f = fixture(protectedTag);
      expect(f.verify()).toEqual(f.receipt);
      expect(f.calls.some((call) => call.includes("compare/" + candidateSha))).toBe(false);
      expect(
        resolveQualificationAdmissionDescriptor({
          repository,
          runId: 40,
          runAttempt: 1,
          workflowRef: f.producer.workflowHeadBranch,
          workflowSha: publisherSha,
          runGh: f.runGh,
        }),
      ).toEqual(f.descriptor);
    },
  );

  it("normalizes omitted empty inputs and the self-referential locator", () => {
    const original = request().inputs;
    const envelope = JSON.parse(
      expectDefined(original.trusted_workflow_json, "trusted workflow envelope"),
    );
    const withLocator = {
      ...original,
      trusted_workflow_json: JSON.stringify({
        ...envelope,
        qualificationAdmission: { artifactId: 70 },
      }),
    };
    expect(semanticQualificationInputs(withLocator)).toEqual(original);
    expect(semanticQualificationInputs({ ...withLocator, optional_spec: "" })).toEqual(original);
    expect(
      semanticQualificationInputs({
        ...withLocator,
        trusted_workflow_json: JSON.stringify({
          ...envelope,
          laneInputs: { extension_test_exclude_patterns_json: '["changed"]' },
          qualificationAdmission: {},
        }),
      }),
    ).not.toEqual(original);
  });

  it.each([
    { reviewed: false },
    { qualificationSha: publisherSha },
    { transportRef: "release-ci/bbbbbbbbbbbb-123" },
  ])("rejects an unattested or changed C=Q tuple: %j", (change) => {
    expect(() => buildQualificationAdmissionRequest({ ...request(), ...change })).toThrow(
      /reviewed C=Q/,
    );
  });

  it.each([
    "failed-run",
    "wrong-attempt",
    "wrong-P",
    "revoked-actor",
    "actions-bot",
    "wrong-actor-id",
    "expired",
    "wrong-upload",
    "generic-success",
  ])("rejects %s instead of trusting workflow success", (failure) => {
    const f = fixture();
    if (failure === "failed-run") {
      f.run.conclusion = "failure";
    }
    if (failure === "wrong-attempt") {
      f.run.run_attempt = 2;
    }
    if (failure === "wrong-P") {
      f.authority.ancestry = "behind";
    }
    if (failure === "revoked-actor") {
      f.authority.permission = "read";
    }
    if (failure === "actions-bot") {
      f.run.actor = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
    }
    if (failure === "wrong-actor-id") {
      f.run.actor = { ...f.actor, id: 999 };
    }
    if (failure === "expired") {
      f.metadata.expires_at = "2000-01-01T00:00:00Z";
    }
    if (failure === "wrong-upload") {
      f.metadata.created_at = "2026-09-27T00:00:02Z";
    }
    if (failure === "generic-success") {
      f.sources.set(
        publisherSha + ":" + QUALIFICATION_ADMISSION_WORKFLOW,
        "name: Arbitrary success\n",
      );
    }
    expect(() => f.verify()).toThrow();
  });

  it("rejects a changed input and a stale protected P tag", () => {
    const f = fixture(true);
    expect(() => f.verify({ ...f.selected.inputs, rerun_group: "ci" })).toThrow(
      /authenticated operator request/,
    );
    f.authority.tagSha = candidateSha;
    expect(() => f.verify()).toThrow(/missing, moved/);
  });

  it("revalidates operator authority after artifact download", () => {
    const f = fixture();
    expect(() =>
      f.verify(f.selected.inputs, () => {
        f.authority.permission = "read";
        return f.archive();
      }),
    ).toThrow(/qualification authority/);
  });

  it("refuses changed archive bytes and UTF-8 archive adapters", () => {
    const f = fixture();
    expect(() => f.verify(f.selected.inputs, () => Buffer.from("not the exact ZIP"))).toThrow(
      /archive bytes/,
    );
    expect(() =>
      verifyQualificationAdmission({
        descriptor: f.descriptor,
        repository,
        candidateSha,
        qualificationSha: candidateSha,
        workflowRef: transportRef,
        runGh: f.runGh,
        downloadArchive: () => new Uint8Array(0),
      }),
    ).toThrow(/archive bytes/);
  });

  it.each([false, true])(
    "revalidates current authority without reacquiring immutable evidence (protected=%s)",
    (protectedTag) => {
      const f = fixture(protectedTag);
      const admission = f.verify();
      const acquired = f.calls.length;
      expect(() =>
        revalidateQualificationAdmissionAuthority({
          descriptor: f.descriptor,
          admission,
          runGh: f.runGh,
        }),
      ).not.toThrow();
      const rechecks = f.calls.slice(acquired);
      expect(rechecks.some((call) => call.includes("/permission"))).toBe(true);
      expect(rechecks.some((call) => call.includes("actions/artifacts/70"))).toBe(true);
      expect(rechecks.some((call) => call.includes("/contents/") || call.endsWith("/zip"))).toBe(
        false,
      );
    },
  );

  it.each([
    "operator",
    "triggering-operator",
    "protected-P",
    "original-attempt",
    "artifact-expiry",
    "artifact-digest",
    "seal-job",
    "dispatch-title",
  ])("denies revoked %s authority after successful acquisition", (fault) => {
    const f = fixture(true);
    const admission = f.verify();
    if (fault === "operator") {
      f.authority.permission = "read";
    }
    if (fault === "triggering-operator") {
      f.run.triggering_actor = { ...f.actor, id: 999 };
    }
    if (fault === "protected-P") {
      f.authority.tagSha = candidateSha;
    }
    if (fault === "original-attempt") {
      f.run.run_attempt = 2;
    }
    if (fault === "artifact-expiry") {
      f.metadata.expires_at = "2000-01-01T00:00:00Z";
    }
    if (fault === "artifact-digest") {
      f.metadata.digest = "sha256:" + "f".repeat(64);
    }
    if (fault === "seal-job") {
      expectDefined(f.jobs.jobs[0], "seal job").conclusion = "failure";
    }
    if (fault === "dispatch-title") {
      f.run.display_title = "different admission request";
    }
    expect(() =>
      revalidateQualificationAdmissionAuthority({
        descriptor: f.descriptor,
        admission,
        runGh: f.runGh,
      }),
    ).toThrow();
  });

  it("rechecks operator grants after publication metadata has been read", () => {
    const f = fixture();
    const admission = f.verify();
    const runGh = (args: string[]) => {
      const value = f.runGh(args);
      if (args.some((arg) => arg.endsWith("actions/artifacts/70"))) {
        f.authority.permission = "read";
      }
      return value;
    };
    expect(() =>
      revalidateQualificationAdmissionAuthority({ descriptor: f.descriptor, admission, runGh }),
    ).toThrow(/qualification authority/);
  });

  it("keeps admission read-only and excludes package preparation", () => {
    const source = readFileSync(".github/workflows/openclaw-release-prepare.yml", "utf8");
    expect(source).toContain("inputs.operation == 'prepare'");
    const admissionJob = source.slice(source.indexOf("  admit_qualification:"));
    expect(admissionJob).toContain("actions: read");
    expect(admissionJob).not.toContain("actions: write");
    expect(admissionJob).not.toContain("secrets:");
    expect(admissionJob).not.toContain("dispatch-prepare");
    expect(admissionJob).toContain("retention-days: 90");
  });
});
