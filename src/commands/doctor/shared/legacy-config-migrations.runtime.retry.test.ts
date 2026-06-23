import { describe, expect, it } from "vitest";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

describe("retry.jitter boolean migration (#52130)", () => {
  it("coerces boolean true jitter to 0.1 at a provider retry path", () => {
    const raw = {
      models: {
        providers: {
          "openai": {
            retry: { jitter: true, attempts: 3 },
          },
        },
      },
    };
    const result = applyLegacyDoctorMigrations(raw);
    expect(result.next?.models?.providers?.openai?.retry?.jitter).toBe(0.1);
    expect(result.next?.models?.providers?.openai?.retry?.attempts).toBe(3);
    expect(result.changes.some((c) => c.includes("retry.jitter"))).toBe(true);
  });

  it("coerces boolean false jitter to 0", () => {
    const raw = { models: { providers: { anthropic: { retry: { jitter: false } } } } };
    const result = applyLegacyDoctorMigrations(raw);
    expect(result.next?.models?.providers?.anthropic?.retry?.jitter).toBe(0);
  });

  it("leaves numeric jitter unchanged", () => {
    const raw = { models: { providers: { openai: { retry: { jitter: 0.25 } } } } };
    const result = applyLegacyDoctorMigrations(raw);
    // Numeric jitter never triggers the boolean migration.
    expect(result.changes.some((c) => c.includes("retry.jitter"))).toBe(false);
    // When no migration fires, the runner returns null (nothing changed).
    if (result.next) {
      expect(result.next.models?.providers?.openai?.retry?.jitter).toBe(0.25);
    }
  });

  it("coerces jitter across multiple nested provider retry configs", () => {
    const raw = {
      models: {
        providers: {
          openai: { retry: { jitter: true } },
          anthropic: { retry: { jitter: false } },
        },
      },
      channels: {
        telegram: { retry: { jitter: true } },
      },
    };
    const result = applyLegacyDoctorMigrations(raw);
    expect(result.next?.models?.providers?.openai?.retry?.jitter).toBe(0.1);
    expect(result.next?.models?.providers?.anthropic?.retry?.jitter).toBe(0);
    expect(result.next?.channels?.telegram?.retry?.jitter).toBe(0.1);
  });

  it("is idempotent: re-running on already-coerced config does not re-trigger", () => {
    const raw = { models: { providers: { openai: { retry: { jitter: true } } } } };
    const first = applyLegacyDoctorMigrations(raw);
    expect(first.next?.models?.providers?.openai?.retry?.jitter).toBe(0.1);
    // Second pass over the coerced config must not report any retry.jitter change.
    const second = applyLegacyDoctorMigrations(first.next ?? raw);
    expect(second.changes.some((c) => c.includes("retry.jitter"))).toBe(false);
    // No retry.jitter migration fires on the second pass (next is null = nothing changed).
    expect(second.next).toBeNull();
  });

  it("does not coerce string boolean jitter values (only actual booleans)", () => {
    const raw = {
      models: { providers: { openai: { retry: { jitter: "true" } } } },
    };
    const result = applyLegacyDoctorMigrations(raw);
    expect(result.changes.some((c) => c.includes("retry.jitter"))).toBe(false);
    if (result.next) {
      expect(result.next.models?.providers?.openai?.retry?.jitter).toBe("true");
    }
  });

  it("does not coerce numeric string jitter values", () => {
    const raw = {
      models: { providers: { openai: { retry: { jitter: "0.5" } } } },
    };
    const result = applyLegacyDoctorMigrations(raw);
    expect(result.changes.some((c) => c.includes("retry.jitter"))).toBe(false);
  });

  it("leaves retry config without a jitter key untouched", () => {
    const raw = {
      models: { providers: { openai: { retry: { attempts: 3, backoffMs: 500 } } } },
    };
    const result = applyLegacyDoctorMigrations(raw);
    expect(result.changes.some((c) => c.includes("retry.jitter"))).toBe(false);
  });

  it("coerces a top-level agents.defaults retry config", () => {
    const raw = {
      agents: { defaults: { retry: { jitter: true, attempts: 2 } } },
    };
    const result = applyLegacyDoctorMigrations(raw);
    expect(result.next?.agents?.defaults?.retry?.jitter).toBe(0.1);
    expect(result.next?.agents?.defaults?.retry?.attempts).toBe(2);
  });

  it("coerces only boolean jitters in a mixed numeric/boolean config", () => {
    const raw = {
      models: {
        providers: {
          openai: { retry: { jitter: true } },
          anthropic: { retry: { jitter: 0.25 } },
          deepseek: { retry: { jitter: false } },
        },
      },
    };
    const result = applyLegacyDoctorMigrations(raw);
    expect(result.next?.models?.providers?.openai?.retry?.jitter).toBe(0.1);
    expect(result.next?.models?.providers?.anthropic?.retry?.jitter).toBe(0.25);
    expect(result.next?.models?.providers?.deepseek?.retry?.jitter).toBe(0);
  });

  it("coerces nested channel retry.jitter (channels.telegram.retry.jitter) (#52130)", () => {
    const raw = {
      channels: {
        telegram: { retry: { jitter: true, attempts: 3 } },
      },
    };
    const result = applyLegacyDoctorMigrations(raw);
    expect(result.next?.channels?.telegram?.retry?.jitter).toBe(0.1);
    expect(result.next?.channels?.telegram?.retry?.attempts).toBe(3);
    expect(result.changes.some((c) => c.includes("retry.jitter"))).toBe(true);
  });

  it("detects nested boolean jitter in legacy rule even when root retry.jitter is absent", () => {
    // The legacy rule should trigger for nested paths, not just root-level retry.jitter.
    const raw = {
      channels: {
        slack: { retry: { jitter: false } },
      },
    };
    const result = applyLegacyDoctorMigrations(raw);
    expect(result.next?.channels?.slack?.retry?.jitter).toBe(0);
  });
});

