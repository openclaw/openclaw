import { spawn } from "node:child_process";
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

  it("samples pressure after a queued heavy-check lock is acquired", async () => {
    const cwd = createTempDir("openclaw-run-tsgo-queued-pressure-");
    const gitDir = path.join(cwd, ".git");
    const lockDir = path.join(gitDir, "openclaw-local-checks", "heavy-check.lock");
    const fakeTsgo = path.join(
      cwd,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsgo.cmd" : "tsgo",
    );
    const ranMarker = path.join(cwd, "tsgo-ran");

    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, tool: "existing-check", cwd })}\n`,
      "utf8",
    );
    fs.mkdirSync(path.dirname(fakeTsgo), { recursive: true });
    fs.writeFileSync(
      fakeTsgo,
      process.platform === "win32"
        ? `@echo off\r\ntype nul > "${ranMarker}"\r\n`
        : `#!/usr/bin/env sh\ntouch "${ranMarker}"\n`,
      "utf8",
    );
    fs.chmodSync(fakeTsgo, 0o755);

    const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "run-tsgo.mjs")], {
      cwd,
      env: {
        ...process.env,
        OPENCLAW_LOCAL_CHECK: "1",
        OPENCLAW_LOCAL_CHECK_MODE: "full",
        OPENCLAW_HEAVY_CHECK_LOCK_POLL_MS: "10",
        OPENCLAW_HEAVY_CHECK_LOCK_PROGRESS_MS: "50",
        OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS: "5000",
        OPENCLAW_HEAVY_CHECK_MIN_MEM_AVAILABLE_BYTES: `${Number.MAX_SAFE_INTEGER}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("queued behind the local heavy-check lock")) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`run-tsgo did not exit after queued lock release. stderr:\n${stderr}`));
      }, 10_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(stderr).toContain("queued behind the local heavy-check lock");
    expect(stderr).toContain("Refusing to start a local heavy check");
    expect(exitCode).toBe(1);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });
});
