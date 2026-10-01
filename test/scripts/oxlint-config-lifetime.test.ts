import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CompilerInputSnapshot } from "../../scripts/lib/compiler-input-snapshot.mts";
import { acquireDistArtifactOwnership } from "../../scripts/lib/dist-artifact-lock.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { runOxlint } from "../../scripts/run-oxlint.mts";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("../../scripts/lib/managed-child-process.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: vi.fn(async () => 0),
}));
afterEach(() => vi.clearAllMocks());
const { createTempDir } = createScriptTestHarness();

it("keeps concurrent compiler input identity stable when lint retires its config", async () => {
  const root = fs.realpathSync(createTempDir("oxlint-config-lifetime-"));
  // Keep artifact ownership inside this fixture when its temp directory has a checkout ancestor.
  fs.mkdirSync(path.join(root, ".git"));
  const config = path.join(root, ".oxlintrc.json");
  fs.writeFileSync(config, JSON.stringify({ rules: { "max-lines": "error" } }));
  fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { types: [] }, files: ["source.ts"] }),
  );
  const snapshot = () =>
    new CompilerInputSnapshot(root, { toolchainFiles: [], generatorInputs: [] });
  const lintFailure = new Error("controlled lint child failure");
  let before: CompilerInputSnapshot | undefined;
  let transient: string | undefined;
  let compilerBlocked = false;
  vi.mocked(runManagedCommand).mockImplementationOnce(async (options) => {
    const index = options.args?.indexOf("--config") ?? -1;
    transient = options.args?.[index + 1];
    expect(transient).not.toBe(config);
    expect(transient && fs.existsSync(transient)).toBe(true);
    const compiler = await acquireDistArtifactOwnership(root).catch((error: unknown) => {
      expect(String(error)).toContain("Could not acquire");
      compilerBlocked = true;
    });
    if (compiler) {
      try {
        before = snapshot();
        before.signature("tsconfig.json", [], ["source.ts"]);
      } finally {
        await compiler.release();
      }
    }
    throw lintFailure;
  });
  await expect(
    runOxlint(["--openclaw-focused-config", "--config", config, "source.ts"], {
      ...process.env,
      GITHUB_ACTIONS: "true",
      OPENCLAW_CI_STATIC_EVIDENCE: "0",
    }),
  ).rejects.toBe(lintFailure);
  expect(transient && fs.existsSync(transient)).toBe(false);
  const compiler = await acquireDistArtifactOwnership(root);
  try {
    if (!before) {
      before = snapshot();
      before.signature("tsconfig.json", [], ["source.ts"]);
    }
    const captured = before;
    expect(() =>
      snapshot().seal("tsconfig.json", [], ["source.ts"], captured, Date.now()),
    ).not.toThrow();
    expect(compilerBlocked).toBe(true);
  } finally {
    await compiler.release();
  }
});
