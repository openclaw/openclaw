import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveCiExtensionLintSelection } from "../../scripts/lib/ci-extension-lint-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function workspace() {
  const cwd = tempDirs.make("extension-lint-selection-");
  const flags = [
    "core.hooksPath=/dev/null",
    "commit.gpgSign=false",
    "user.name=Fixture",
    "user.email=fixture@example.invalid",
  ].flatMap((value) => ["-c", value]);
  const git = (args: string[]) =>
    execFileSync("git", [...flags, ...args], { cwd, encoding: "utf8" });
  const write = (file: string, content: string) => {
    const target = path.join(cwd, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    git(["add", "--", file]);
  };
  git(["init", "--quiet"]);
  write("scripts/lib/plugin-sdk-entrypoints.json", '["api", "public"]');
  write("scripts/lib/plugin-sdk-private-local-only-subpaths.json", "[]");
  for (const id of ["alpha", "beta", "unrelated", "telegram", "codex", "slack"]) {
    write(`extensions/${id}/package.json`, '{"private":true}');
  }
  write(
    "extensions/alpha/index.ts",
    'import type { Result } from "openclaw/plugin-sdk/public"; export type Response = Result;\n',
  );
  write(
    "extensions/beta/index.ts",
    'import type { Response } from "../alpha/index.js"; export type Reply = Response;\n',
  );
  git(["commit", "--quiet", "--allow-empty", "-m", "fixture base"]);
  return { cwd, write, baseRef: git(["rev-parse", "HEAD"]).trim() };
}

const smokeRoots = ["extensions/codex", "extensions/slack", "extensions/telegram"];
type SelectionOptions = {
  pinned?: boolean;
  testImport?: boolean;
  reasons?: Record<string, string[]>;
};
const alpha = "extensions/alpha";
const unrelated = "extensions/unrelated";
const importReason = (entry: string, file: string) => [
  `direct import of changed public entry openclaw/plugin-sdk/${entry}: ${file}`,
];
const selectedCases: [string[], string[], SelectionOptions?][] = [
  [["ui/src/leaf.ts", `${unrelated}/README.md`], []],
  [["src/leaf.ts", `${unrelated}/README.md`], smokeRoots],
  [[`${alpha}/index.ts`, `${unrelated}/README.md`], [alpha]],
  [["config/oxlint/README.md"], []],
  [[".github/actions/setup-node-env/README.md"], []],
  [[`${alpha}/test/fixtures/README.md`], [alpha]],
  [[`${alpha}/prompts/runtime.md`], [alpha]],
  [
    ["src/plugin-sdk/public.ts", `${unrelated}/openclaw.plugin.json`],
    [alpha, ...smokeRoots, unrelated],
    {
      pinned: true,
      reasons: {
        [alpha]: importReason("public", `${alpha}/index.ts`),
        [unrelated]: [`PR changes ${unrelated}/openclaw.plugin.json`],
      },
    },
  ],
  [["ui/src/leaf.ts", "docs/example.md"], [], { reasons: {} }],
  [["src/leaf.ts"], smokeRoots],
  [["scripts/lib/settings.mts"], smokeRoots],
  [[`${alpha}/package.json`], [alpha]],
  [
    ["src/plugin-sdk/api.ts"],
    [...smokeRoots, unrelated],
    {
      pinned: true,
      testImport: true,
      reasons: {
        [unrelated]: importReason("api", `${unrelated}/api.test.ts`),
      },
    },
  ],
];
const fullCases: [string, { forceFull?: boolean; baseRef?: string }?, string?][] = [
  ...[
    "pnpm-lock.yaml",
    "extensions/tsconfig.json",
    "config/oxlint/boundary-guards.json",
    "config/tsconfig/oxlint.json",
    "patches/example.patch",
    "src/state/openclaw-state-schema.sql",
  ].map((file): [string] => [file]),
  ["extensions/shared.ts", {}, "direct shared extension source: extensions/shared.ts"],
  ["docs/example.md", { forceFull: true }, "OPENCLAW_CI_EXTENSION_LINT_FULL"],
  [
    "src/plugin-sdk/public.ts",
    { baseRef: "a".repeat(40) },
    "direct public-entry inventory unavailable",
  ],
];

it("rejects invalid paths before excluding documentation", async () => {
  const { cwd } = workspace();
  await expect(resolveCiExtensionLintSelection(["../docs/README.md"], cwd)).rejects.toThrow(
    "Invalid changed extension lint path",
  );
});

it.each(selectedCases)(
  "selects direct owners and smoke consumers of %j",
  async (files, roots, options = {}) => {
    const { cwd, write, baseRef } = workspace();
    if (options.testImport) {
      write(
        "extensions/unrelated/api.test.ts",
        'import type { Result } from "openclaw/plugin-sdk/api";\n',
      );
    }
    const selection = await resolveCiExtensionLintSelection(
      files,
      cwd,
      options.pinned ? { baseRef } : {},
    );
    const expected = { mode: "selected", extensionRoots: roots, fullReasons: [] };
    if (roots.length === 0) {
      expect(selection).toEqual({ ...expected, reasons: {} });
    } else {
      expect(selection).toMatchObject({
        ...expected,
        ...(options.reasons ? { reasons: options.reasons } : {}),
      });
    }
  },
);

it.each(fullCases)("retains full lint for %s", async (file, options, reason) => {
  const { cwd } = workspace();
  const selection = await resolveCiExtensionLintSelection([file], cwd, options);
  expect(selection).toMatchObject({ mode: "full", fullReasons: [reason ?? expect.any(String)] });
  if (file === "extensions/shared.ts") {
    expect(selection.extensionRoots).toEqual([]);
  }
});
