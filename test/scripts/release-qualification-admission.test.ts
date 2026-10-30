import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  buildQualificationAdmissionRequest,
  resolveQualificationAdmissionDescriptor,
  revalidateQualificationAdmissionAuthority,
  semanticQualificationInputs,
  QUALIFICATION_ADMISSION_WORKFLOW,
} from "../../scripts/release-qualification-admission.mjs";
import {
  candidateSha,
  publisherSha,
  request,
  fixture,
} from "./release-qualification-admission.test-support.js";

const envelope = (inputs = request().inputs) =>
  JSON.parse(expectDefined(inputs.trusted_workflow_json, "trusted workflow envelope"));
const withEnvelope = (trusted: Record<string, unknown>, inputs = request().inputs) => ({
  ...inputs,
  trusted_workflow_json: JSON.stringify(trusted),
});
const withBaselines = (override: Record<string, unknown> | null, inputs = request().inputs) => {
  const trusted = envelope(inputs);
  trusted.laneInputs.qualification_baselines_json =
    override === null
      ? ""
      : JSON.stringify({
          ...JSON.parse(trusted.laneInputs.qualification_baselines_json),
          ...override,
        });
  return withEnvelope(trusted, inputs);
};
type Fixture = ReturnType<typeof fixture>;
const revalidate = (f: Fixture, admission: ReturnType<Fixture["verify"]>, runGh = f.runGh) =>
  revalidateQualificationAdmissionAuthority({ descriptor: f.descriptor, admission, runGh });
const change =
  <K extends "run" | "authority" | "metadata">(target: K, values: Partial<Fixture[K]>) =>
  (f: Fixture) =>
    Object.assign(f[target], values);

it.each([
  [{ mode: "upgrade" }, "requires mode=both"],
  [
    { plugin_prerelease_node_exclude_patterns_json: '["extensions/codex/*.test.ts"]' },
    "cannot exclude Plugin Prerelease Node tests",
  ],
  [
    { release_profile: "stable", skip_package_telegram_e2e: "true" },
    "cannot skip Package Telegram E2E",
  ],
  [{ codex_plugin_spec: "npm:@openclaw/codex@latest" }, "codex_plugin_spec"],
] as const)("rejects narrowed qualification inputs %j", (inputs, error) => {
  expect(() => fixture(false, { inputs })).toThrow(error);
});

it.each([
  ["empty", null],
  [
    "future",
    {
      upgradeBaseline: "openclaw@2027.1.1",
      upgradeSurvivorBaselines: ["openclaw@2026.6.34", "openclaw@2027.1.1"],
    },
  ],
  ["altered-primary", { upgradeBaseline: "openclaw@2026.7.8" }],
] as const)("rejects %s baselines without a registry fallback", (_fault, override) => {
  expect(() => fixture(false, { inputs: withBaselines(override) })).toThrow(
    /baseline|predecessor/i,
  );
});

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
  const substituted = withBaselines(
    {
      upgradeBaseline: "openclaw@2026.7.8",
      upgradeSurvivorBaselines: ["openclaw@2026.6.34", "openclaw@2026.7.8"],
    },
    f.selected.inputs,
  );
  expect(() => f.verify(substituted)).toThrow(/authenticated operator request/);
});
it.each([false, true])("authenticates P without Q main ancestry (protected=%s)", (protectedTag) => {
  const f = fixture(protectedTag);
  expect(f.verify()).toEqual(f.receipt);
  expect(f.calls.some((call) => call.includes("compare/" + candidateSha))).toBe(false);
  expect(
    resolveQualificationAdmissionDescriptor({
      ...f.producer,
      workflowRef: f.producer.workflowHeadBranch,
      runGh: f.runGh,
    }),
  ).toEqual(f.descriptor);
});

it("removes only the self-referential locator and retains unknown semantic fields", () => {
  const original = request().inputs;
  const trusted = envelope(original);
  const withLocator = withEnvelope({ ...trusted, qualificationAdmission: { artifactId: 70 } });
  expect(semanticQualificationInputs(withLocator)).toEqual(original);
  trusted.laneInputs = { extension_test_exclude_patterns_json: '["changed"]' };
  trusted.qualificationAdmission = {};
  expect(semanticQualificationInputs(withEnvelope(trusted, withLocator))).not.toEqual(original);
});

it("accepts admitted empty strings omitted from the child run inputs context", () => {
  const f = fixture();
  const { codex_plugin_spec: _omitted, ...observed } = f.selected.inputs;
  expect(f.verify(observed)).toEqual(f.receipt);
});

it.each([
  { reviewed: false },
  { qualificationSha: publisherSha },
  { transportRef: "release-ci/bbbbbbbbbbbb-123" },
])("rejects an unattested or changed C=Q tuple: %j", (override) => {
  expect(() => buildQualificationAdmissionRequest({ ...request(), ...override })).toThrow(
    /reviewed C=Q/,
  );
});

it.each([
  ["failed-run", change("run", { conclusion: "failure" })],
  ["wrong-P", change("authority", { ancestry: "behind" })],
  [
    "actions-bot",
    change("run", { actor: { id: 41898282, login: "github-actions[bot]", type: "Bot" } }),
  ],
  ["wrong-upload", change("metadata", { created_at: "2026-09-27T00:00:02Z" })],
  [
    "generic-success",
    (f: Fixture) =>
      f.sources.set(
        publisherSha + ":" + QUALIFICATION_ADMISSION_WORKFLOW,
        "name: Arbitrary success\n",
      ),
  ],
] as const)("rejects %s instead of trusting workflow success", (_failure, mutate) => {
  const f = fixture();
  mutate(f);
  expect(() => f.verify()).toThrow();
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

it("accepts GitHub's empty step inventory for a successful exact producer job", () => {
  const f = fixture();
  expectDefined(f.jobs.jobs[0], "admission job").steps = [];
  expect(() => f.verify()).not.toThrow();
});

it("refuses changed archive bytes and UTF-8 archive adapters", () => {
  const f = fixture();
  expect(() => f.verify(f.selected.inputs, () => Buffer.from("not the exact ZIP"))).toThrow(
    /archive bytes/,
  );
  expect(() => f.verify(f.selected.inputs, () => new Uint8Array(0))).toThrow(/archive bytes/);
});

it("revalidates current authority without reacquiring immutable evidence (protected)", () => {
  const f = fixture(true);
  const admission = f.verify();
  const acquired = f.calls.length;
  expect(() => revalidate(f, admission)).not.toThrow();
  const rechecks = f.calls.slice(acquired);
  expect(rechecks.some((call) => call.includes("/permission"))).toBe(true);
  expect(rechecks.some((call) => call.includes("actions/artifacts/70"))).toBe(true);
  expect(rechecks.filter((call) => /\/contents\/|\/zip$/.test(call))).toEqual([]);
});

it.each([
  ["triggering-operator", (f: Fixture) => Object.assign(f.run.triggering_actor, { id: 999 })],
  ["protected-P", change("authority", { tagSha: candidateSha })],
  ["original-attempt", change("run", { run_attempt: 2 })],
  ["artifact-expiry", change("metadata", { expires_at: "2000-01-01T00:00:00Z" })],
  ["artifact-digest", change("metadata", { digest: "sha256:" + "f".repeat(64) })],
  [
    "seal-job",
    (f: Fixture) =>
      Object.assign(expectDefined(f.jobs.jobs[0], "seal job"), { conclusion: "failure" }),
  ],
  ["dispatch-title", change("run", { display_title: "different admission request" })],
] as const)("denies revoked %s authority after successful acquisition", (_fault, mutate) => {
  const f = fixture(true);
  const admission = f.verify();
  mutate(f);
  expect(() => revalidate(f, admission)).toThrow();
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
  expect(() => revalidate(f, admission, runGh)).toThrow(/qualification authority/);
});

it("keeps admission read-only and excludes package preparation", () => {
  const source = readFileSync(".github/workflows/openclaw-release-prepare.yml", "utf8");
  expect(source).toContain("inputs.operation == 'prepare'");
  const admissionJob = source.slice(source.indexOf("  admit_qualification:"));
  expect(admissionJob).toContain("actions: read");
  expect(admissionJob).not.toMatch(/actions: write|secrets:|dispatch-prepare/);
  expect(admissionJob).toContain("retention-days: 90");
});
