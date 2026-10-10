import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveUiE2ePrTestSelection,
  hasSharedUiE2eInput,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { listTrackedTestFiles } from "../../scripts/lib/list-test-files.mts";
import uiNodeConfig from "../../ui/vitest.node.config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import {
  filterFilesByPatterns,
  intersectIncludePatterns,
  narrowIncludePatterns,
  nonBrowserTestBasenamePattern,
} from "../vitest/vitest.include-patterns.ts";
import { matchesVitestGlob } from "../vitest/vitest.pattern-file.ts";
import {
  controlUiTestGlobs,
  controlUiE2eTestGlobs,
  isUiBrowserTestFile,
  isUiTestTarget,
  resolveUiTypeScriptPath,
} from "../vitest/vitest.ui-paths.mjs";
import { createUiVitestConfig } from "../vitest/vitest.ui.config.ts";

const temporary = useAutoCleanupTempDirTracker(afterEach);

function fixture(files: Record<string, string>) {
  const cwd = temporary.make("ui-tsx-discovery-");
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(cwd, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return cwd;
}

describe("TSX discovery", () => {
  it.each([false, true])("retains indexed TSX owners in sparse checkouts (linked=%s)", (linked) => {
    const cwd = fixture({ "ui/src/view.tsx": "export {};\n", "kept/marker": "retained\n" });
    const options = { cwd, env: createNestedGitEnv(), encoding: "utf8" } as const;
    execFileSync("git", ["init", "-q"], options);
    execFileSync("git", ["add", "."], options);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "test: seed sparse owners",
      ],
      options,
    );
    const checkout = linked ? temporary.make("ui-sparse-worktree-") : cwd;
    if (linked) {
      execFileSync("git", ["worktree", "add", "--detach", "--quiet", checkout], options);
    }
    execFileSync("git", ["sparse-checkout", "set", "--no-cone", "/kept/"], {
      ...options,
      cwd: checkout,
    });
    expect(existsSync(path.join(checkout, "ui/src/view.tsx"))).toBe(false);
    expect(resolveUiTypeScriptPath("ui/src/view.ts", checkout)).toBe("ui/src/view.tsx");
  });

  it("retains isolated execution ownership for an unstaged TSX rename", () => {
    const original = "ui/src/app/bootstrap.test.ts";
    const renamed = `${original}x`;
    const cwd = fixture({
      [original]: "export {};\n",
      "test/vitest/vitest.ui-paths.mjs": readFileSync(
        new URL("../vitest/vitest.ui-paths.mjs", import.meta.url),
        "utf8",
      ),
      "test/vitest/vitest.ui-isolated-paths.mjs": readFileSync(
        new URL("../vitest/vitest.ui-isolated-paths.mjs", import.meta.url),
        "utf8",
      ),
    });
    const options = { cwd, env: createNestedGitEnv(), encoding: "utf8" } as const;
    execFileSync("git", ["init", "-q"], options);
    execFileSync("git", ["add", "--", original], options);
    renameSync(path.join(cwd, original), path.join(cwd, renamed));
    const moduleUrl = pathToFileURL(
      path.join(cwd, "test/vitest/vitest.ui-isolated-paths.mjs"),
    ).href;
    const isolated: string[] = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const { uiIsolatedTestFiles } = await import(${JSON.stringify(moduleUrl)});\n` +
            "console.log(JSON.stringify(uiIsolatedTestFiles));",
        ],
        options,
      ),
    );
    expect(isolated).toContain(renamed);
    expect(isolated).not.toContain(original);
  });

  it("preserves Git pathspec discovery for PR proof planning", () => {
    const files = [
      "ui/src/view.test.ts",
      "ui/src/view.test.tsx",
      "ui/src/view.e2e.test.ts",
      "ui/src/view.e2e.test.tsx",
      "extensions/example/browser/view.test.ts",
      "extensions/example/browser/view.test.tsx",
    ];
    const cwd = fixture(Object.fromEntries(files.map((file) => [file, "export {};\n"])));
    const options = { cwd, env: createNestedGitEnv(), encoding: "utf8" } as const;
    execFileSync("git", ["init", "-q"], options);
    execFileSync("git", ["add", "--", ...files], options);
    for (const [patterns, expected] of [
      [controlUiTestGlobs, files],
      [controlUiE2eTestGlobs, files.filter((file) => file.includes(".e2e."))],
    ] as const) {
      const selected = execFileSync(
        "git",
        ["ls-files", "--", ...patterns.map((pattern) => `:(glob)${pattern}`)],
        options,
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(selected.toSorted()).toEqual(expected.toSorted());
    }
  });

  it("retains bootstrap and E2E helper ownership in the UI compiler shards", () => {
    for (const shard of ["app", "components", "pages", "e2e", "e2e-chat", "other", "chat"]) {
      const config: { include: string[]; exclude?: string[] } = JSON.parse(
        readFileSync(
          new URL(`../tsconfig/tsconfig.core.test.ui-${shard}.json`, import.meta.url),
          "utf8",
        ),
      );
      for (const extension of ["ts", "tsx"]) {
        expect(config.include, shard).toContain(`../../ui/src/main.${extension}`);
        for (const [file, owner] of [
          [`../../ui/src/test-helpers/control-ui-e2e-example.test.${extension}`, "e2e"],
          [`../../ui/src/e2e/about.e2e.test.${extension}`, "e2e"],
          [`../../ui/src/e2e/chat-example.e2e.test.${extension}`, "e2e-chat"],
        ] as const) {
          const selected = filterFilesByPatterns(
            [file],
            config.include,
            config.exclude ?? [],
            matchesVitestGlob,
          );
          expect(selected, shard).toEqual(shard === owner ? [file] : []);
        }
      }
    }
  });

  it("assigns synthetic TSX tests to exactly one package project", async () => {
    vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", "");
    vi.stubEnv("OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE", "");
    vi.resetModules();
    let uiConfig: typeof import("../../ui/vitest.config.ts").default;
    try {
      uiConfig = (await import("../../ui/vitest.config.ts")).default;
    } finally {
      vi.unstubAllEnvs();
    }
    type UiProject = Extract<
      NonNullable<NonNullable<typeof uiConfig.test>["projects"]>[number],
      { test?: unknown }
    >;
    for (const [file, expected] of [
      ["src/component.test.tsx", "unit"],
      ["src/component.node.test.tsx", "unit-node"],
      ["src/component.browser.test.tsx", "browser"],
      ["../extensions/example/browser/view.test.tsx", "unit"],
    ] as const) {
      const projects = (uiConfig.test?.projects ?? []).filter(
        (project): project is UiProject =>
          typeof project === "object" && project !== null && "test" in project,
      );
      expect(
        projects
          .filter(
            ({ test }) =>
              filterFilesByPatterns(
                [file],
                test?.include ?? [],
                test?.exclude ?? [],
                matchesVitestGlob,
              ).length,
          )
          .map(({ test }) => test?.name),
      ).toEqual([expected]);
      if (expected === "unit-node") {
        expect(
          filterFilesByPatterns([file], uiNodeConfig.test?.include ?? [], [], matchesVitestGlob),
        ).toEqual([file]);
      }
      const root = createUiVitestConfig({}).test!;
      const repositoryFile = path.posix.normalize(`ui/${file}`);
      expect(
        filterFilesByPatterns(
          [repositoryFile],
          root.include ?? [],
          root.exclude ?? [],
          matchesVitestGlob,
        ),
      ).toEqual(expected === "browser" ? [] : [repositoryFile]);
    }
  });

  it("discovers both extensions while preserving browser and E2E boundaries", () => {
    const files = [
      "ui/src/component.test.ts",
      "ui/src/component.test.tsx",
      "ui/src/component.browser.test.tsx",
      "ui/src/component.e2e.test.tsx",
      "ui/src/component.tsx",
      "extensions/example/browser/view.test.tsx",
    ];
    const cwd = fixture(Object.fromEntries(files.map((file) => [file, "export {};\n"])));
    expect(listTrackedTestFiles(cwd).map((file) => path.relative(cwd, file))).toEqual(
      files.filter((file) => file.includes(".test.")).toSorted(),
    );
    expect(files.filter(isUiTestTarget)).toEqual([files[0], files[1], files[2], files[5]]);
    expect(files.filter(isUiBrowserTestFile)).toEqual([files[2]]);
    expect(isUiBrowserTestFile("ui/src/pages/chat/chat-responsive.browser.test.tsx")).toBe(false);
    expect(filterFilesByPatterns(files, controlUiTestGlobs, [], matchesVitestGlob)).toEqual(
      files.filter((file) => file.includes(".test.")),
    );
    const owner = ["ui/src/**/" + nonBrowserTestBasenamePattern];
    for (const extension of ["ts", "tsx", "{ts,tsx}"]) {
      const selected = intersectIncludePatterns(
        owner,
        [`ui/src/**/*.test.${extension}`],
        matchesVitestGlob,
      )!;
      expect(filterFilesByPatterns(files, selected, [], matchesVitestGlob)).toEqual(
        files
          .slice(0, 2)
          .filter((file) => extension === "{ts,tsx}" || file.endsWith(`.${extension}`))
          .concat(extension === "ts" ? [] : [files[3]!]),
      );
    }
  });

  it("resolves a renamed owner without changing present or missing inventory entries", () => {
    const cwd = fixture({ "ui/src/view.tsx": "export {};", "ui/src/helper.ts": "export {};" });
    expect(resolveUiTypeScriptPath("ui/src/view.ts", cwd)).toBe("ui/src/view.tsx");
    expect(resolveUiTypeScriptPath("ui/src/helper.ts", cwd)).toBe("ui/src/helper.ts");
    expect(resolveUiTypeScriptPath("ui/src/missing.ts", cwd)).toBe("ui/src/missing.ts");
  });

  it("preserves explicit extension bounds through overlapping and unioned globs", () => {
    expect(
      narrowIncludePatterns(
        ["ui/src/**/*.test.{ts,tsx}"],
        ["ui/src/components/*.test.ts"],
        matchesVitestGlob,
      ),
    ).toEqual(["ui/src/**/*.test.ts"]);
    expect(
      intersectIncludePatterns(
        ["ui/src/**/*.test.ts"],
        ["ui/src/**/*.test.tsx"],
        matchesVitestGlob,
      ),
    ).toEqual([]);
    expect(
      intersectIncludePatterns(
        ["ui/src/**/*.test.ts", "ui/src/**/*.test.tsx"],
        ["ui/src/**/*.test.{ts,tsx}"],
        matchesVitestGlob,
      ),
    ).toEqual(["ui/src/**/*.test.ts", "ui/src/**/*.test.tsx"]);
  });

  it("selects the existing CI owners for TSX tests, routes, components, and helpers", () => {
    const cwd = fixture({
      "ui/src/e2e/cron-descriptions.e2e.test.tsx": 'import "../test-helpers/fixture.tsx";',
      "ui/src/e2e/agent-config-save.e2e.test.tsx": "export {};",
      "ui/src/e2e/unlisted.e2e.test.tsx": "export {};",
      "ui/src/pages/cron/route.tsx": "export const route = {};",
      "ui/src/components/select-picker.tsx": "export const view = <select />;",
      "ui/src/test-helpers/fixture.tsx": "export const view = <section />;",
    });
    const cases = [
      ["ui/src/e2e/unlisted.e2e.test.tsx", "ui/src/e2e/unlisted.e2e.test.tsx", "edited test"],
      [
        "ui/src/pages/cron/route.tsx",
        "ui/src/e2e/cron-descriptions.e2e.test.tsx",
        "explicit source-owner watch",
      ],
      [
        "ui/src/components/select-picker.tsx",
        "ui/src/e2e/agent-config-save.e2e.test.tsx",
        "direct route/component dependency: ui/src/components/select-picker.tsx",
      ],
      [
        "ui/src/test-helpers/fixture.tsx",
        "ui/src/e2e/cron-descriptions.e2e.test.tsx",
        "test or fixture import dependency",
      ],
    ] as const;
    const selection = resolveUiE2ePrTestSelection(
      cases.map(([changed]) => changed),
      { cwd },
    );
    for (const [, target, reason] of cases) {
      expect(selection.mode).toBe("owners");
      expect(selection.files).toContain(target);
      expect(selection.reasons[target]).toContain(reason);
    }
  });

  it("retains full UI coverage for a renamed shared shell or harness", () => {
    expect(hasSharedUiE2eInput(["ui/src/app/router-outlet.tsx"])).toBe(true);
    expect(hasSharedUiE2eInput(["ui/src/test-helpers/control-ui-e2e.tsx"])).toBe(true);
    expect(hasSharedUiE2eInput(["ui/src/app/router-outlet.test.tsx"])).toBe(false);
  });
});
