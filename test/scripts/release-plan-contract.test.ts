import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalReleasePlanJson,
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
  parseReleasePlanLockJson,
  RELEASE_PLAN_CANONICALIZATION,
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

function rejects(overrides: PlanOverrides, message: string, base = sourceFixture) {
  expect(() => validateReleasePlan(plan(overrides, base))).toThrow(message);
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

describe("release plan contract", () => {
  it("pins exact canonical source and lock bytes as the cross-repo golden fixture", () => {
    expect(RELEASE_PLAN_CANONICALIZATION).toBe("ascii-sorted-compact-json-trailing-newline-v1");
    expect(sourceText).toBe(canonicalReleasePlanJson(sourceFixture));
    expect(lockText).toBe(canonicalReleasePlanLockJson(lockFixture));
    expect(createReleasePlanLock(sourceFixture)).toEqual(lockFixture);
    expect(parseReleasePlanLockJson(lockText)).toEqual(lockFixture);
    expect(lockText.endsWith("\n")).toBe(true);
    expect(lockText.slice(0, -1)).toMatch(/^[\x20-\x7e]+$/u);
  });

  it("rejects alpha as beta publication authority", () => {
    rejects(
      { purpose: "beta-publish", ...versionFields("2026.9.24-alpha.1") },
      "Alpha releases are retired;",
    );
  });

  it("rejects duplicate, reordered, pretty, CRLF, and non-ASCII lock bytes", () => {
    for (const [before, after] of [
      ['{"digest":', `{"digest":"${String(lockFixture.digest)}","digest":`],
      ['"tooling":{"ref":', '"tooling":{"ref":"ignored","\\u0072ef":'],
      [
        '{"name":"@openclaw/example","targets":',
        '{"name":"ignored","name":"@openclaw/example","targets":',
      ],
    ] as const) {
      expect(() => parseReleasePlanLockJson(lockText.replace(before, after))).toThrow(
        "duplicate key",
      );
    }
    expect(() =>
      parseReleasePlanLockJson(
        `${JSON.stringify({
          schema: lockFixture.schema,
          plan: lockFixture.plan,
          digest: lockFixture.digest,
        })}\n`,
      ),
    ).toThrow("canonical bytes");
    expect(() => parseReleasePlanLockJson(`${JSON.stringify(lockFixture, null, 2)}\n`)).toThrow(
      "compact printable ASCII",
    );
    expect(() => parseReleasePlanLockJson(lockText.replace(/\n$/u, "\r\n"))).toThrow(
      "exactly one trailing LF",
    );
    expect(() =>
      parseReleasePlanLockJson(lockText.replace("openclaw/openclaw", "opénclaw")),
    ).toThrow("printable ASCII");
  });

  it("rejects values that JSON.stringify would erase or coerce", () => {
    for (const [value, error] of [
      [undefined, "unsupported undefined"],
      [Number.NaN, "must be finite"],
      [Number.POSITIVE_INFINITY, "canonical JSON"],
      [Number.NEGATIVE_INFINITY, "canonical JSON"],
      [() => undefined, "canonical JSON"],
      [Symbol("ignored"), "canonical JSON"],
      [1n, "canonical JSON"],
      [-0, "negative zero"],
    ] as const) {
      expect(() => canonicalReleasePlanJson({ ...sourceFixture, ignored: value })).toThrow(error);
    }
  });

  it("rejects non-tree and non-data JSON structures", () => {
    const sparseGroups = ["all"];
    sparseGroups.length = 3;
    sparseGroups[2] = "package";
    expect(() =>
      canonicalReleasePlanJson(plan({ validation: { allowed_groups: sparseGroups } })),
    ).toThrow("must be dense");

    const augmentedGroups = ["all", "ci", "package"];
    Object.defineProperty(augmentedGroups, "metadata", { enumerable: true, value: "ignored" });
    expect(() =>
      canonicalReleasePlanJson(plan({ validation: { allowed_groups: augmentedGroups } })),
    ).toThrow("no extra properties");

    const cyclic = { ...sourceFixture } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => canonicalReleasePlanJson(cyclic)).toThrow("must not contain cycles");

    const nonPlain = Object.assign(new Date(0), sourceFixture);
    expect(() => canonicalReleasePlanJson(nonPlain)).toThrow("must be plain");

    const accessor = { ...sourceFixture };
    Object.defineProperty(accessor, "hidden", { enumerable: true, get: () => "ignored" });
    expect(() => canonicalReleasePlanJson(accessor)).toThrow("enumerable data properties");

    const symbolKey = { ...sourceFixture, [Symbol("ignored")]: true };
    expect(() => canonicalReleasePlanJson(symbolKey)).toThrow("must use string keys");
  });

  it("enforces the purpose, version, tag, and target context matrix", () => {
    rejects(
      {
        purpose: "stable-publish",
        validation: { ...fullValidation, intent: "release-stable", profile: "stable" },
      },
      "stable-publish release plan version must be stable",
    );
    rejects(
      {
        purpose: "main-qualification",
        tag: null,
        target_context_ref: "refs/tags/null",
        validation: { ...fullValidation, intent: "main-weekly" },
      },
      "candidate SHA context",
    );
    rejects({ tag: "v2026.8.1-beta.3" }, "exact version tag context");
  });

  it("binds purpose, intent, profile, and soak to one authoritative policy", () => {
    rejects(
      { validation: { intent: "release-stable" } },
      "beta-publish does not allow validation intent",
    );
    rejects({ validation: { profile: "full" } }, "profile assertion conflicts");
    rejects({ validation: { soak: true } }, "soak assertion conflicts");
  });

  it("keeps diagnostic plans tagless, non-publishable, and distinct from qualification", () => {
    const diagnosticPlan = validateReleasePlan(
      plan({
        purpose: "diagnostic",
        tag: null,
        target_context_ref: sourceFixture.candidate_sha,
        tooling: { ref: "refs/heads/main" },
        validation: { ...fullValidation, intent: "diagnostic-full" },
      }),
    );
    expect(diagnosticPlan).toMatchObject({
      purpose: "diagnostic",
      tag: null,
      target_context_ref: sourceFixture.candidate_sha,
      validation: { intent: "diagnostic-full", profile: "full", soak: true },
    });

    rejects(
      {
        tag: sourceFixture.tag,
        target_context_ref: sourceFixture.target_context_ref,
      },
      "diagnostic release plans require a null tag and candidate SHA context",
      diagnosticPlan,
    );
    rejects(
      {
        validation: { intent: "release-beta", profile: "beta", soak: false },
      },
      "diagnostic does not allow validation intent",
      diagnosticPlan,
    );
    rejects(
      { tooling: { ref: "refs/heads/feature" } },
      "diagnostic tooling must use trusted main or a protected release-publish tag",
      diagnosticPlan,
    );
  });

  it("rejects unknown authority, invalid ordering, and unsupported versions", () => {
    rejects({ run_id: "123" }, "release plan keys must be exactly");
    rejects(versionFields("2026.08.1-beta.2"), "supported release version");
    rejects(
      {
        inventory: {
          packages: sourceFixture.inventory.packages.toReversed(),
        },
      },
      "ascending ASCII order",
    );
  });

  it("rejects arbitrary tooling routes", () => {
    rejects({ tooling: { ref: "refs/heads/main" } }, "protected release-publish tag");
    rejects({ tooling: { ref: "refs/tags/release-publish/cccccccccccc-123" } }, "bound to its SHA");
    rejects(
      {
        purpose: "main-qualification",
        tag: null,
        target_context_ref: sourceFixture.candidate_sha,
        tooling: { ref: "refs/heads/feature" },
        validation: { ...fullValidation, intent: "main-weekly" },
      },
      "trusted main",
    );
  });
});
