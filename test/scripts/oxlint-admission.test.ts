import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { runSemanticCheck } from "../../scripts/lib/semantic-check-admission.mts";
import { runOxlint } from "../../scripts/run-oxlint.mts";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("../../scripts/lib/semantic-check-admission.mts", () => ({
  runSemanticCheck: vi.fn(async () => 0),
}));
vi.mock("../../scripts/lib/managed-child-process.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: vi.fn(async () => 0),
}));
afterEach(() => vi.clearAllMocks());
const { createTempDir } = createScriptTestHarness();
const env = {
  ...process.env,
  GITHUB_ACTIONS: "false",
  OPENCLAW_CI_STATIC_EVIDENCE: "0",
  OPENCLAW_OXLINT_SKIP_PREPARE: "1",
};

it.for([["--help"], ["-h"], ["--version"], ["-V"]])(
  "allows the exact metadata command %j without semantic admission",
  async (args) => {
    expect((await runOxlint(args, env)).status).toBe(0);
    expect(runManagedCommand).toHaveBeenCalledOnce();
    expect(runSemanticCheck).not.toHaveBeenCalled();
  },
);

it.for([
  ["src/index.ts"],
  ["--lsp"],
  ["--help", "src/index.ts"],
  ["--version", "src/index.ts"],
  ["--config", "--help", "src/index.ts"],
  ["--", "--openclaw-focused-config"],
])("admits every other native command %j even when preparation is skipped", async (args) => {
  expect((await runOxlint(args, env)).status).toBe(0);
  expect(runSemanticCheck).toHaveBeenCalledOnce();
  expect(runManagedCommand).not.toHaveBeenCalled();
});

it.for([
  { config: {}, extra: ["--type-aware"] },
  { config: {}, extra: ["--type-check"] },
  { config: {}, extra: ["--type-check-only"] },
  { config: {}, extra: ["--lsp"] },
  { config: { options: { typeAware: true } }, extra: [] },
  { config: { options: { typeCheck: true } }, extra: [] },
  { config: { extends: ["parent.json"] }, extra: [] },
  { config: { jsPlugins: ["arbitrary.mjs"] }, extra: [] },
  { config: { overrides: [{ files: ["**/*.ts"], jsPlugins: ["arbitrary.mjs"] }] }, extra: [] },
  { config: {}, extra: ["--config", "second.json"] },
  { config: {}, extra: ["-csecond.json"] },
])(
  "rejects an unqualified focused exception %j before any child starts",
  async ({ config, extra }) => {
    const file = path.join(createTempDir("oxlint-focused-"), "config.json");
    fs.writeFileSync(file, JSON.stringify(config));
    await expect(
      runOxlint(["--openclaw-focused-config", "--config", file, ...extra], env),
    ).rejects.toThrow("Remove --openclaw-focused-config");
    expect(runSemanticCheck).not.toHaveBeenCalled();
    expect(runManagedCommand).not.toHaveBeenCalled();
  },
);

it.for(["missing", "executable"])("requires explicit inert focused config: %s", async (kind) => {
  await expect(
    runOxlint(
      [
        "--openclaw-focused-config",
        ...(kind === "missing" ? [] : ["--config", "oxlint.config.ts"]),
      ],
      env,
    ),
  ).rejects.toThrow("explicit JSON/JSONC");
  expect(runManagedCommand).not.toHaveBeenCalled();
});

it("preserves the repository's reviewed syntax-only boundary plugin", async () => {
  expect(
    (
      await runOxlint(
        [
          "--openclaw-focused-config",
          "--config",
          "config/oxlint/boundary-guards.json",
          "scripts/run-oxlint.mts",
        ],
        env,
      )
    ).status,
  ).toBe(0);
  expect(runManagedCommand).toHaveBeenCalledOnce();
  expect(runSemanticCheck).not.toHaveBeenCalled();
});

it("does not mistake a bare plugin package name for the reviewed relative module", async () => {
  const read = vi
    .spyOn(fs, "readFileSync")
    .mockReturnValueOnce(JSON.stringify({ jsPlugins: ["oxlint-boundary-guards.mjs"] }));
  try {
    await expect(
      runOxlint(["--openclaw-focused-config", "--config", "scripts/focused.json"], env),
    ).rejects.toThrow("unreviewed JavaScript plugins");
    expect(runManagedCommand).not.toHaveBeenCalled();
    expect(runSemanticCheck).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it.for([false, true])(
  "retains native config only while cleanup is uncertain: %s",
  async (uncertain) => {
    const root = createTempDir("oxlint-advisory-owner-");
    const config = path.join(root, "config.json");
    fs.writeFileSync(config, JSON.stringify({ rules: { "max-lines": "error" } }));
    const failure = Object.assign(new Error("native failure"), {
      processTreeState: uncertain ? "indeterminate" : "terminated",
    });
    vi.mocked(runSemanticCheck).mockRejectedValueOnce(failure);
    await expect(
      runOxlint(["--config", config, "scripts/run-oxlint.mts"], {
        ...env,
        GITHUB_ACTIONS: "true",
      }),
    ).rejects.toBe(failure);
    expect(fs.readdirSync(root).filter((file) => file.startsWith(".oxlint-limits-"))).toHaveLength(
      uncertain ? 1 : 0,
    );
  },
);
