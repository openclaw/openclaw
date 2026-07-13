// Cron command env normalization regression tests (#105433).
import { describe, expect, it } from "vitest";
import { validateCronAddParams } from "../../packages/gateway-protocol/src/index.js";
import { normalizeCronJobCreate } from "./normalize.js";

describe("normalizeCronJobCreate command env (#105433)", () => {
  it("keeps valid command env vars when a sibling value is non-string", () => {
    const normalized = normalizeCronJobCreate({
      name: "command env non-string sibling",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: {
        kind: "command",
        argv: ["sh", "-lc", "echo ok"],
        env: { DEBUG: true, PATH: "/bin" },
      },
    }) as unknown as Record<string, unknown>;

    // One non-string value must not wipe the whole env block; the valid PATH
    // string survives, matching normalizeTrimmedStringArray's filter semantics.
    expect((normalized.payload as Record<string, unknown>).env).toEqual({ PATH: "/bin" });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("drops the command env block only when no valid entries remain", () => {
    const normalized = normalizeCronJobCreate({
      name: "command env all non-string",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: {
        kind: "command",
        argv: ["sh", "-lc", "echo ok"],
        env: { DEBUG: true },
      },
    }) as unknown as Record<string, unknown>;

    // Matches normalizeTrimmedStringArray: an all-invalid map normalizes away
    // entirely instead of persisting a non-string value.
    expect("env" in (normalized.payload as Record<string, unknown>)).toBe(false);
    expect(validateCronAddParams(normalized)).toBe(true);
  });
});
