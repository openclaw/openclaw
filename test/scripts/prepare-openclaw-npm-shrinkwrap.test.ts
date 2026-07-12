import { describe, expect, it } from "vitest";
import {
  assertPreparedOpenClawNpmShrinkwrap,
  prepareOpenClawNpmShrinkwrap,
} from "../../scripts/prepare-openclaw-npm-shrinkwrap.ts";

const AI_DEPENDENCIES = {
  "@anthropic-ai/sdk": "0.109.1",
  openai: "6.45.0",
};

function createShrinkwrap() {
  return {
    lockfileVersion: 3,
    packages: {
      "": {
        name: "openclaw",
        version: "2026.7.1-beta.5",
        dependencies: {
          openai: "6.45.0",
        },
      },
      "node_modules/@anthropic-ai/sdk": {
        version: "0.109.1",
      },
      "node_modules/openai": {
        version: "6.45.0",
      },
    },
  };
}

describe("prepareOpenClawNpmShrinkwrap", () => {
  it("adds the exact registry AI runtime dependency to the root shrinkwrap", () => {
    const prepared = prepareOpenClawNpmShrinkwrap({
      aiIntegrity: "sha512-test",
      aiManifest: {
        name: "@openclaw/ai",
        version: "2026.7.1-beta.5",
        license: "MIT",
        engines: { node: ">=22.19.0" },
        dependencies: AI_DEPENDENCIES,
      },
      rootManifest: {
        name: "openclaw",
        version: "2026.7.1-beta.5",
      },
      shrinkwrap: createShrinkwrap(),
    });

    expect(prepared.packages?.[""]?.dependencies).toEqual({
      "@openclaw/ai": "2026.7.1-beta.5",
      openai: "6.45.0",
    });
    expect(prepared.packages?.["node_modules/@openclaw/ai"]).toEqual({
      version: "2026.7.1-beta.5",
      resolved: "https://registry.npmjs.org/@openclaw/ai/-/ai-2026.7.1-beta.5.tgz",
      integrity: "sha512-test",
      license: "MIT",
      dependencies: AI_DEPENDENCIES,
      engines: { node: ">=22.19.0" },
    });
    expect(() =>
      assertPreparedOpenClawNpmShrinkwrap({
        aiIntegrity: "sha512-test",
        aiManifest: {
          name: "@openclaw/ai",
          version: "2026.7.1-beta.5",
          license: "MIT",
          engines: { node: ">=22.19.0" },
          dependencies: AI_DEPENDENCIES,
        },
        rootManifest: {
          name: "openclaw",
          version: "2026.7.1-beta.5",
        },
        shrinkwrap: prepared,
      }),
    ).not.toThrow();
  });

  it("rejects mismatched versions and incomplete dependency graphs", () => {
    expect(() =>
      prepareOpenClawNpmShrinkwrap({
        aiIntegrity: "sha512-test",
        aiManifest: {
          name: "@openclaw/ai",
          version: "2026.7.1-beta.4",
          dependencies: AI_DEPENDENCIES,
        },
        rootManifest: {
          name: "openclaw",
          version: "2026.7.1-beta.5",
        },
        shrinkwrap: createShrinkwrap(),
      }),
    ).toThrow("does not match OpenClaw");

    const incomplete = createShrinkwrap();
    delete incomplete.packages["node_modules/openai"];
    expect(() =>
      prepareOpenClawNpmShrinkwrap({
        aiIntegrity: "sha512-test",
        aiManifest: {
          name: "@openclaw/ai",
          version: "2026.7.1-beta.5",
          dependencies: AI_DEPENDENCIES,
        },
        rootManifest: {
          name: "openclaw",
          version: "2026.7.1-beta.5",
        },
        shrinkwrap: incomplete,
      }),
    ).toThrow("missing AI runtime dependency openai");

    expect(() =>
      assertPreparedOpenClawNpmShrinkwrap({
        aiIntegrity: "sha512-test",
        aiManifest: {
          name: "@openclaw/ai",
          version: "2026.7.1-beta.5",
          dependencies: AI_DEPENDENCIES,
        },
        rootManifest: {
          name: "openclaw",
          version: "2026.7.1-beta.5",
        },
        shrinkwrap: createShrinkwrap(),
      }),
    ).toThrow("does not lock the exact @openclaw/ai tarball");
  });
});
