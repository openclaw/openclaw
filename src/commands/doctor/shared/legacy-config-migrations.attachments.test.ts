import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { OpenClawSchema } from "../../../config/zod-schema.js";
import { migrateLegacyConfigForTest as migrate } from "./legacy-config-migrate.apply.test-support.js";

describe("attachment limit cutover", () => {
  it.each([1, 51, 0.0000001, 1e308])("preserves the old decoded file cap for %s MiB", (mb) => {
    const raw = { agents: { defaults: { mediaMaxMb: mb } }, attachments: { ttlHours: 24 } };
    expect(
      findLegacyConfigIssues(raw).some((issue) => issue.path === "agents.defaults.mediaMaxMb"),
    ).toBe(true);
    const result = migrate(raw);
    const fileMb =
      Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(mb * 1048576))) / 1048576;
    expect(result.config).toMatchObject({
      agents: { defaults: { mediaMaxMb: mb } },
      attachments: { ttlHours: 24, maxFileMb: fileMb },
    });
    expect(raw.attachments).toEqual({ ttlHours: 24 });
    expect(migrate(result.config).changes).toEqual([]);
  });

  it("preserves explicit independent settings and needs no default-only migration", () => {
    const raw = {
      agents: { defaults: { mediaMaxMb: 1 } },
      attachments: { maxFileMb: 10, maxTotalMb: 15, ttlHours: 24 },
    };
    expect(migrate(raw).changes).toEqual([]);
    expect(migrate({}).changes).toEqual([]);
    const totalOnly = migrate({
      agents: { defaults: { mediaMaxMb: 3 } },
      attachments: { maxTotalMb: 2 },
    });
    expect(totalOnly.config?.attachments).toEqual({ maxFileMb: 3, maxTotalMb: 2 });
  });

  it("validates representable byte limits without changing existing retention", () => {
    expect(
      OpenClawSchema.safeParse({
        attachments: { maxFileMb: 1 / 1048576, maxTotalMb: 2, ttlHours: 24 },
      }).success,
    ).toBe(true);
    for (const value of [0, -1, Number.NaN, Infinity, 0.0000001, 1e308]) {
      for (const field of ["maxFileMb", "maxTotalMb"]) {
        expect(OpenClawSchema.safeParse({ attachments: { [field]: value } }).success).toBe(false);
      }
    }
  });
});
