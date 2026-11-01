import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalReleasePlanJson,
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
  parseReleasePlanLockJson,
  validateReleasePlan,
  type ReleasePlan,
} from "../../scripts/release-plan-contract.mjs";

const fixtureDir = resolve("test/fixtures");
const sourceText = readFileSync(resolve(fixtureDir, "release-plan-v1.source.json"), "utf8");
const lockText = readFileSync(
  resolve(fixtureDir, "release-plan-lock-v1.compatibility.json"),
  "utf8",
);
const sourceFixture = JSON.parse(sourceText) as ReleasePlan;
const lockFixture = JSON.parse(lockText) as Record<string, unknown>;

type PlanOverrides = Record<string, unknown> & {
  validation?: Record<string, unknown>;
  tooling?: Record<string, unknown>;
  inventory?: Record<string, unknown>;
};

function plan(overrides: PlanOverrides = {}, base = sourceFixture) {
  return {
    ...base,
    ...overrides,
    validation: { ...base.validation, ...overrides.validation },
    tooling: { ...base.tooling, ...overrides.tooling },
    inventory: { ...base.inventory, ...overrides.inventory },
  };
}

function versionFields(version: string) {
  return {
    version,
    release_id: version,
    tag: `v${version}`,
    target_context_ref: `refs/tags/v${version}`,
  };
}

const fullValidation = { allowed_groups: ["all", "ci", "package"], profile: "full", soak: true };
const rejectJson = (value: unknown, error: string) =>
  expect(() => canonicalReleasePlanJson(value)).toThrow(error);
const rejectLock = (text: string, error: string) =>
  expect(() => parseReleasePlanLockJson(text)).toThrow(error);

describe("release plan contract", () => {
  it("pins exact canonical source and lock bytes as the cross-repo golden fixture", () => {
    expect(sourceText).toBe(canonicalReleasePlanJson(sourceFixture));
    expect(lockText).toBe(canonicalReleasePlanLockJson(lockFixture));
    expect(createReleasePlanLock(sourceFixture)).toEqual(lockFixture);
    expect(parseReleasePlanLockJson(lockText)).toEqual(lockFixture);
  });

  it("rejects duplicate, reordered, CRLF, and non-ASCII lock bytes", () => {
    for (const [before, after] of [
      ['{"digest":', `{"digest":"${String(lockFixture.digest)}","digest":`],
      ['"tooling":{"ref":', '"tooling":{"ref":"ignored","\\u0072ef":'],
    ] as const) {
      rejectLock(lockText.replace(before, after), "duplicate key");
    }
    rejectLock(
      `${JSON.stringify({ schema: lockFixture.schema, plan: lockFixture.plan, digest: lockFixture.digest })}\n`,
      "canonical bytes",
    );
    rejectLock(lockText.replace(/\n$/u, "\r\n"), "exactly one trailing LF");
    rejectLock(lockText.replace("openclaw/openclaw", "opénclaw"), "printable ASCII");
  });

  it("rejects values that JSON.stringify would erase or coerce", () => {
    for (const [value, error] of [
      [undefined, "unsupported undefined"],
      [Number.NaN, "must be finite"],
      [-0, "negative zero"],
    ] as const) {
      rejectJson({ ...sourceFixture, ignored: value }, error);
    }
  });

  it("rejects non-tree and non-data JSON structures", () => {
    const sparseGroups = ["all"];
    sparseGroups.length = 3;
    sparseGroups[2] = "package";
    rejectJson(plan({ validation: { allowed_groups: sparseGroups } }), "must be dense");

    const augmentedGroups = ["all", "ci", "package"];
    Object.defineProperty(augmentedGroups, "metadata", { enumerable: true, value: "ignored" });
    rejectJson(plan({ validation: { allowed_groups: augmentedGroups } }), "no extra properties");

    const cyclic = { ...sourceFixture } as Record<string, unknown>;
    cyclic.self = cyclic;
    rejectJson(cyclic, "must not contain cycles");
    rejectJson(Object.assign(new Date(0), sourceFixture), "must be plain");

    const accessor = { ...sourceFixture };
    Object.defineProperty(accessor, "hidden", { enumerable: true, get: () => "ignored" });
    rejectJson(accessor, "enumerable data properties");
    rejectJson({ ...sourceFixture, [Symbol("ignored")]: true }, "must use string keys");
  });

  it.each<[PlanOverrides, string]>([
    [
      { purpose: "beta-publish", ...versionFields("2026.9.24-alpha.1") },
      "Alpha releases are retired;",
    ],
    [{ purpose: "stable-publish" }, "stable-publish release plan version must be stable"],
    [{ tag: "v2026.8.1-beta.3" }, "exact version tag context"],
    [{ validation: { intent: "release-stable" } }, "beta-publish does not allow validation intent"],
    [{ run_id: "123" }, "release plan keys must be exactly"],
    [versionFields("2026.08.1-beta.2"), "supported release version"],
    [
      { inventory: { packages: sourceFixture.inventory.packages.toReversed() } },
      "ascending ASCII order",
    ],
    [{ tooling: { ref: "refs/heads/main" } }, "protected release-publish tag"],
    [{ tooling: { ref: "refs/tags/release-publish/cccccccccccc-123" } }, "bound to its SHA"],
  ])("rejects conflicting release authority: %s", (overrides, error) => {
    expect(() => validateReleasePlan(plan(overrides))).toThrow(error);
  });

  it("rejects publication context, intent, and untrusted tooling in diagnostic plans", () => {
    const diagnosticPlan = plan({
      purpose: "diagnostic",
      tag: null,
      target_context_ref: sourceFixture.candidate_sha,
      tooling: { ref: "refs/heads/main" },
      validation: { ...fullValidation, intent: "diagnostic-full" },
    });

    const invalid: [PlanOverrides, string][] = [
      [
        { tag: sourceFixture.tag, target_context_ref: sourceFixture.target_context_ref },
        "diagnostic release plans require a null tag and candidate SHA context",
      ],
      [
        { validation: { intent: "release-beta", profile: "beta", soak: false } },
        "diagnostic does not allow validation intent",
      ],
      [
        { tooling: { ref: "refs/heads/feature" } },
        "diagnostic tooling must use trusted main or a protected release-publish tag",
      ],
    ];
    for (const [overrides, error] of invalid) {
      expect(() => validateReleasePlan(plan(overrides, diagnosticPlan))).toThrow(error);
    }
  });
});
