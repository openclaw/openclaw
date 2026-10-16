import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { SkillEntry, SkillSnapshot } from "../types.js";
import { applySkillEnvOverrides, applySkillEnvOverridesFromSnapshot } from "./env-overrides.js";

const SAG_PRIMARY = "ELEVENLABS_API_KEY";
const SAG_ALT = "SAG_API_KEY";

function withClearedEnv<T>(keys: string[], run: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of keys) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return run();
  } finally {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function sagEntry(): SkillEntry[] {
  return [
    {
      skill: {
        name: "sag-skill",
        description: "TTS",
        filePath: "/virtual/sag-skill/SKILL.md",
        baseDir: "/virtual/sag-skill",
        source: "test",
        sourceInfo: {
          path: "/virtual/sag-skill/SKILL.md",
          source: "test",
          scope: "temporary",
          origin: "top-level",
        },
        disableModelInvocation: false,
      },
      frontmatter: {},
      metadata: {
        primaryEnv: SAG_PRIMARY,
        requires: { anyEnv: [SAG_PRIMARY, SAG_ALT] },
      },
    },
  ];
}

function sagEnvConfig(env: Record<string, string>): OpenClawConfig {
  return { skills: { entries: { "sag-skill": { env } } } } as OpenClawConfig;
}

describe("applySkillEnvOverrides anyEnv propagation (#147346)", () => {
  it("injects an anyEnv-only key from skills.entries.<id>.env (direct path)", () => {
    withClearedEnv([SAG_ALT], () => {
      // pragma: allowlist secret -- synthetic test credential
      const restore = applySkillEnvOverrides({
        skills: sagEntry(),
        config: sagEnvConfig({ [SAG_ALT]: "sag-secret" }),
      });
      try {
        expect(process.env[SAG_ALT]).toBe("sag-secret");
      } finally {
        restore();
        expect(process.env[SAG_ALT]).toBeUndefined();
      }
    });
  });

  it("injects an anyEnv-only key from a snapshot (snapshot path)", () => {
    const snapshot: SkillSnapshot = {
      prompt: "",
      skills: [
        {
          name: "sag-skill",
          primaryEnv: SAG_PRIMARY,
          requiredEnv: [],
          anyEnv: [SAG_PRIMARY, SAG_ALT],
        },
      ],
    };
    withClearedEnv([SAG_ALT], () => {
      // pragma: allowlist secret -- synthetic test credential
      const restore = applySkillEnvOverridesFromSnapshot({
        snapshot,
        config: sagEnvConfig({ [SAG_ALT]: "sag-secret" }),
      });
      try {
        expect(process.env[SAG_ALT]).toBe("sag-secret");
      } finally {
        restore();
        expect(process.env[SAG_ALT]).toBeUndefined();
      }
    });
  });

  it("still blocks always-blocked keys even with anyEnv declared", () => {
    withClearedEnv(["OPENSSL_CONF"], () => {
      // pragma: allowlist secret -- synthetic test credential
      const restore = applySkillEnvOverrides({
        skills: sagEntry(),
        config: sagEnvConfig({ OPENSSL_CONF: "nope" }),
      });
      try {
        expect(process.env.OPENSSL_CONF).toBeUndefined();
      } finally {
        restore();
      }
    });
  });
});
