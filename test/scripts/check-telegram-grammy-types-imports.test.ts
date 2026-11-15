import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("checks Telegram TS and TSX imports while preserving safe imports and excluded directories", () => {
  const root = tempDirs.make("openclaw-telegram-type-imports-");
  mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  mkdirSync(path.join(root, "extensions/telegram/dist"), { recursive: true });
  for (const file of ["check-telegram-grammy-types-imports.mts", "lib/repo-root.mjs"]) {
    copyFileSync(path.resolve("scripts", file), path.join(root, "scripts", file));
  }
  writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const invalidFiles = ["invalid.ts", "invalid.tsx"];
  for (const file of invalidFiles) {
    writeFileSync(
      path.join(root, "extensions/telegram", file),
      'import type { Message } from "@grammyjs/types";',
    );
  }
  writeFileSync(
    path.join(root, "extensions/telegram/safe.tsx"),
    'import type { Message } from "grammy/types"; const view = <div />;',
  );
  writeFileSync(
    path.join(root, "extensions/telegram/dist/ignored.tsx"),
    'import type { Message } from "@grammyjs/types";',
  );
  const run = () =>
    spawnSync(process.execPath, ["scripts/check-telegram-grammy-types-imports.mts"], {
      cwd: root,
      encoding: "utf8",
    });
  const rejected = run();
  expect(rejected.error).toBeUndefined();
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain("extensions/telegram/invalid.ts:1");
  expect(rejected.stderr).toContain("extensions/telegram/invalid.tsx:1");
  expect(rejected.stderr).not.toContain("safe.tsx");
  expect(rejected.stderr).not.toContain("ignored.tsx");

  for (const file of invalidFiles) {
    unlinkSync(path.join(root, "extensions/telegram", file));
  }
  const accepted = run();
  expect(accepted.error).toBeUndefined();
  expect(accepted.status).toBe(0);
  expect(accepted.stderr).toBe("");
});
