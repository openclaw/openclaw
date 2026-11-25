/// <reference types="vite/client" />

import { expect, it, vi } from "vitest";

it.each(["OPENCLAW_VITEST_ENV_DELETE", "DEV", "PROD", "SSR"])(
  "deletes %s from the current environment through stubEnv",
  (key) => {
    const original = process.env;
    try {
      process.env = { ...original, [key]: "present" };
      vi.stubEnv(key, undefined);
      expect(process.env[key]).toBeUndefined();
      expect(key in import.meta.env).toBe(false);
      if (key !== "OPENCLAW_VITEST_ENV_DELETE") {
        expect(import.meta.env[key]).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
      process.env = original;
    }
  },
);

it("unstubs an originally absent key from the current environment", () => {
  const original = process.env;
  const key = "OPENCLAW_VITEST_ENV_RESTORE";
  try {
    process.env = { ...original };
    delete process.env[key];
    vi.stubEnv(key, "stubbed");
    expect(process.env[key]).toBe("stubbed");
    expect.soft(key in import.meta.env).toBe(true);
    vi.unstubAllEnvs();
    expect(process.env[key]).toBeUndefined();
    expect(key in import.meta.env).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    process.env = original;
  }
});

it("enumerates the retained target with current values after an environment swap", () => {
  const original = process.env;
  try {
    process.env = { ...original, VITEST: "replacement", DEV: "" };
    expect(Object.keys(import.meta.env)).toContain("VITEST");
    expect({ ...import.meta.env }).toMatchObject({ VITEST: "replacement" });
  } finally {
    process.env = original;
  }
});
