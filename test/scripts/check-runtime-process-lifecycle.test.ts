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
  const manifest = (entries: string) =>
    write(
      "src/infra/runtime-process-manifest.ts",
      `export function createRuntimeProcessEntrypoints() { return { ${entries} } as const; }\n`,
    );
  const lifecycleFile = "scripts/runtime-process-lifecycle.json";
  const legacy = 'existing: loaderFreeEntrypoint("infra/existing")';
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
  write(lifecycleFile, JSON.stringify({ added: declaration(64) }));
  git("add", ".");
  expect(main(root, ["--staged", "--base", "HEAD"])).toBe(0);
  git("commit", "-qm", "declare new launcher");

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
    'existing: runtimeProcessEntrypoint("infra/existing"), added: runtimeProcessEntrypoint("infra/added")',
  );
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(error).toHaveBeenLastCalledWith(
    expect.stringContaining("existing (src/infra/existing.ts) needs a launch mode"),
  );
});
