// Tests for openclaw.claw.v1 manifest parsing.
import { describe, expect, it } from "vitest";
import { buildClawPlan } from "./plan.js";
import { parseClawManifest } from "./schema.js";

const baseManifest = {
  schemaVersion: "openclaw.claw.v1",
  id: "financial-analyst",
  name: "Financial Analyst",
  version: "1.0.0",
  entries: [
    {
      kind: "skill",
      id: "sec-filings",
      selector: "clawhub:sec-filings@1.0.0",
    },
    {
      kind: "workspaceFile",
      id: "soul",
      path: "SOUL.md",
      source: "files/SOUL.md",
    },
  ],
};

describe("parseClawManifest", () => {
  it("parses known claw entries and defaults entries to required", () => {
    const result = parseClawManifest(baseManifest);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected manifest to parse");
    }
    expect(result.manifest.entries).toHaveLength(2);
    expect(result.manifest.entries[0]).toMatchObject({
      kind: "skill",
      id: "sec-filings",
      required: true,
    });
  });

  it("warns for optional unknown entry kinds without invalidating the manifest", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        ...baseManifest.entries,
        {
          kind: "futureThing",
          id: "future-entry",
          required: false,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected manifest to parse");
    }
    expect(result.manifest.optionalUnknownEntries).toEqual([
      { kind: "futureThing", id: "future-entry", required: false },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "unsupported_optional_entry",
        path: "$.entries[2]",
      }),
    ]);
  });


  it("fails unknown top-level manifest keys", () => {
    const result = parseClawManifest({
      ...baseManifest,
      surprise: true,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        path: "$",
      }),
    ]);
  });

  it("fails unknown keys on known entries", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "example-plugin",
          selector: "npm:@openclaw/plugin-example@1.0.0",
          extra: true,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        path: "$.entries[0]",
      }),
    ]);
  });

  it("fails malformed optional entries with known kinds", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "missing-selector",
          required: false,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        path: "$.entries[0].selector",
      }),
    ]);
  });

  it("reports nested paths for malformed known entry fields", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "bad-selector",
          selector: 1,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        path: "$.entries[0].selector",
      }),
    ]);
  });

  it("fails required unknown entry kinds", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "futureThing",
          id: "future-entry",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.level === "error")).toBe(true);
  });
});

describe("buildClawPlan", () => {
  it("marks workspace and automation entries as future consent points", () => {
    const parsed = parseClawManifest({
      ...baseManifest,
      entries: [
        ...baseManifest.entries,
        {
          kind: "schedule",
          id: "morning-brief",
          source: "automations/morning-brief.json",
          enableDefault: false,
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected manifest to parse");
    }

    const plan = buildClawPlan({ manifest: parsed.manifest, sourcePath: "/tmp/claw.json" });

    expect(plan.readOnly).toBe(true);
    expect(plan.summary).toMatchObject({
      totalEntries: 3,
      requiredEntries: 3,
      requiresConsent: 2,
    });
    expect(plan.entries.map((entry) => entry.decision)).toEqual([
      "inspectOnly",
      "requiresConsent",
      "requiresConsent",
    ]);
  });
});
