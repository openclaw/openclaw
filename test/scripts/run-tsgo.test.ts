import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getLocalHeavyCheckPressureError,
  prepareLocalHeavyCheckEnvironment,
} from "../../scripts/lib/local-heavy-check-runtime.mjs";
import {
  createSparseTsgoSkipEnv,
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "../../scripts/lib/tsgo-sparse-guard.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("run-tsgo sparse guard", () => {
  it("ignores non-core projects", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.extensions.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toBeNull();
  });

  it("ignores full worktrees", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => false,
      }),
    ).toBeNull();
  });

  it("ignores metadata-only commands", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json", "--showConfig"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toBeNull();
  });

  it("ignores sparse worktrees when the required files are present", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const requiredPaths = [
      "packages/plugin-package-contract/src/index.ts",
      "ui/src/i18n/lib/registry.ts",
      "ui/src/i18n/lib/types.ts",
      "ui/src/ui/app-settings.ts",
      "ui/src/ui/gateway.ts",
    ];

    for (const relativePath of requiredPaths) {
      const absolutePath = path.join(cwd, relativePath);
      const dir = path.dirname(absolutePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absolutePath, "", "utf8");
    }

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.non-agents.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: ["/packages/", "/ui/src/"],
      }),
    ).toBeNull();
  });

  it("rejects sparse core worktrees that include only selected ui and package files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const requiredPaths = [
      "packages/plugin-package-contract/src/index.ts",
      "ui/src/i18n/lib/registry.ts",
      "ui/src/i18n/lib/types.ts",
      "ui/src/ui/app-settings.ts",
      "ui/src/ui/gateway.ts",
    ];

    for (const relativePath of requiredPaths) {
      const absolutePath = path.join(cwd, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, "", "utf8");
    }

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: [
          "/packages/plugin-package-contract/src/index.ts",
          "/ui/src/i18n/lib/registry.ts",
          "/ui/src/i18n/lib/types.ts",
          "/ui/src/ui/app-settings.ts",
          "/ui/src/ui/gateway.ts",
        ],
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.test.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - packages
      - ui/src
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("returns a helpful message for sparse core worktrees missing transitive project files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const uiToolDisplay = path.join(cwd, "ui/src/ui/tool-display.ts");
    fs.mkdirSync(path.dirname(uiToolDisplay), { recursive: true });
    fs.writeFileSync(uiToolDisplay, "", "utf8");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.core.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("returns a helpful message for sparse core-test worktrees missing ui and packages files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.test.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - packages/plugin-package-contract/src/index.ts
      - ui/src/i18n/lib/registry.ts
      - ui/src/i18n/lib/types.ts
      - ui/src/ui/app-settings.ts
      - ui/src/ui/gateway.ts
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("recognizes the check:changed sparse-skip env", () => {
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "1" })).toBe(true);
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "true" })).toBe(true);
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "0" })).toBe(false);
    expect(createSparseTsgoSkipEnv({ PATH: "/usr/bin" })).toMatchObject({
      PATH: "/usr/bin",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
    });
  });
});

describe("run-tsgo pressure guard", () => {
  it("allows heavy checks when memory and temp space have headroom", () => {
    expect(
      getLocalHeavyCheckPressureError({
        env: {},
        hostPressure: {
          memAvailableBytes: 4 * 1024 ** 3,
          tmpAvailableBytes: 2 * 1024 ** 3,
          tmpUsedPercent: 25,
        },
      }),
    ).toBeNull();
  });

  it("refuses heavy checks when temp space or memory is already pressured", () => {
    expect(
      getLocalHeavyCheckPressureError({
        env: {},
        hostPressure: {
          memAvailableBytes: 512 * 1024 ** 2,
          tmpAvailableBytes: 256 * 1024 ** 2,
          tmpUsedPercent: 91,
        },
      }),
    ).toMatchInlineSnapshot(`
      "Refusing to start a local heavy check because this host is already under pressure:
      - MemAvailable 512 MiB is below 1.5 GiB
      - temp directory available 256 MiB is below 1.0 GiB
      - temp directory is 91% used (limit 80%)
      Wait for pressure to clear, free temp space, or rerun with OPENCLAW_HEAVY_CHECK_FORCE=1 if you really mean it."
    `);
  });

  it("lets explicit force bypass pressure refusal", () => {
    expect(
      getLocalHeavyCheckPressureError({
        env: { OPENCLAW_HEAVY_CHECK_FORCE: "1" },
        hostPressure: {
          memAvailableBytes: 1,
          tmpAvailableBytes: 1,
          tmpUsedPercent: 99,
        },
      }),
    ).toBeNull();
  });

  it("routes local heavy-check temp files into the worktree artifact directory", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const env = prepareLocalHeavyCheckEnvironment({ cwd, env: {} });
    const expectedTmp = path.join(cwd, ".artifacts", "tmp", "local-heavy-checks");

    expect(env.TMPDIR).toBe(expectedTmp);
    expect(env.TEMP).toBe(expectedTmp);
    expect(env.TMP).toBe(expectedTmp);
    expect(fs.existsSync(expectedTmp)).toBe(true);
  });
});
