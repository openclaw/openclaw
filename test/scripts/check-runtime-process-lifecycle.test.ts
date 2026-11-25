import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-runtime-process-lifecycle.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("requires lifecycle budgets for new and retargeted core entrypoints", () => {
  const root = tempDirs.make("openclaw-runtime-lifecycle-");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: "pipe" },
    ).trim();
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const manifest = (entries: string, defaultExtension = ".ts") =>
    write(
      "src/infra/runtime-process-manifest.ts",
      `export function createRuntimeProcessEntrypoints() {
        const runtimeProcessEntrypoint = (path, distPath, distExtension, sourceExtension) =>
          ({ sourceModulePath: \u0060src/\${path}\${sourceExtension ?? "${defaultExtension}"}\u0060 }) as const;
        const loaderFreeEntrypoint = (modulePath) =>
          runtimeProcessEntrypoint(modulePath, undefined, undefined, ".mjs");
        return { ${entries} } as const;
      }\n`,
    );
  const lifecycleFile = "scripts/runtime-process-lifecycle.json";
  const legacy =
    'existing: loaderFreeEntrypoint("infra/existing"), defaulted: runtimeProcessEntrypoint("infra/defaulted")';
  const owner = "src/infra/owner.ts";
  const declaration = (expectedMiB: number | null) => ({
    whenNeeded: {
      owner,
      start: "lazy",
      retire: "Exit after producing the result.",
      memory: { scope: "process-rss", expectedMiB },
    },
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  git("init", "-q");
  manifest(legacy);
  git("add", ".");
  git("commit", "-qm", "base without registry");
  write(lifecycleFile, "{}");
  expect(main(root, ["--staged", "--base", "HEAD"])).toBe(1);
  expect(main(root, ["--base", "HEAD"])).toBe(0);

  manifest(`${legacy}, added: runtimeProcessEntrypoint("infra/added")`);
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(error).toHaveBeenLastCalledWith(
    expect.stringContaining("added (src/infra/added.ts) needs a launch mode"),
  );
  write(owner, "export {};\n");
  write(lifecycleFile, JSON.stringify({ added: declaration(null) }));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(error).toHaveBeenLastCalledWith(
    expect.stringContaining("needs an expected memory budget"),
  );
  const budgeted = declaration(64);
  const twoModes = { added: { ...budgeted, queued: budgeted.whenNeeded } };
  write(lifecycleFile, JSON.stringify(twoModes));
  git("add", ".");
  expect(main(root, ["--staged", "--base", "HEAD"])).toBe(0);
  git("commit", "-qm", "declare new launcher");

  write(lifecycleFile, JSON.stringify({ added: budgeted }));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(error).toHaveBeenLastCalledWith(
    expect.stringContaining("added/queued was removed without changing its lifecycle owner"),
  );
  write(owner, "export const queued = false;\n");
  expect(main(root, ["--base", "HEAD"])).toBe(0);

  write(lifecycleFile, JSON.stringify({ added: declaration(null) }));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(error).toHaveBeenLastCalledWith(
    expect.stringContaining(
      "added/whenNeeded (src/infra/added.ts) needs an expected memory budget",
    ),
  );
  write(lifecycleFile, "{}");
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  manifest(
    `${legacy.replace("loaderFreeEntrypoint", "runtimeProcessEntrypoint")}, added: runtimeProcessEntrypoint("infra/added")`,
  );
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(error).toHaveBeenLastCalledWith(
    expect.stringContaining("existing (src/infra/existing.ts) needs a launch mode"),
  );
  write(lifecycleFile, JSON.stringify(twoModes));
  manifest(`${legacy}, added: runtimeProcessEntrypoint("infra/added")`, ".mts");
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(error).toHaveBeenLastCalledWith(
    expect.stringContaining("defaulted (src/infra/defaulted.mts) needs a launch mode"),
  );
});
