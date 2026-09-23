import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pkgQueryResult } from "../../infra/update-freebsd-pkg-ownership.test-support.js";
import * as exec from "../../process/exec.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";

describe("retireStandaloneGitWrapper", () => {
  it.each([
    ...["replacement", "content change", "oversized file", "directory", "revoked finalizer"].map(
      (change) => ({ change, stage: "pkg inspection" }),
    ),
    ...["replacement", "revoked finalizer"].map((change) => ({ change, stage: "wrapper read" })),
  ])("preserves a wrapper after $change during $stage", async ({ change, stage }) => {
    await withTestDir({ prefix: "openclaw-wrapper-race-" }, async (base) => {
      const root = path.join(base, "old");
      const wrapper = path.join(base, "openclaw");
      const original = `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${root}/dist/entry.js "$@"\n`;
      const replacement = "#!/bin/sh\necho replacement\n";
      await fs.writeFile(wrapper, original, { mode: 0o755 });
      let revoked = false;
      const assertCurrent = vi.fn(() => {
        if (revoked) {
          throw new Error("finalizer revoked");
        }
      });
      const changeWrapper = async () => {
        if (change === "replacement") {
          await fs.rename(wrapper, path.join(base, "saved"));
          await fs.writeFile(wrapper, original, { mode: 0o755 });
        } else if (change === "directory") {
          await fs.rename(wrapper, path.join(base, "saved"));
          await fs.mkdir(wrapper);
        } else if (change === "oversized file") {
          await fs.writeFile(wrapper, "x".repeat(4097));
        } else if (change === "content change") {
          await fs.writeFile(wrapper, replacement);
        } else {
          revoked = true;
        }
      };
      const readFile = fs.readFile;
      const observation =
        stage === "pkg inspection"
          ? vi.spyOn(exec, "runCommandBuffered").mockImplementationOnce(async () => {
              await changeWrapper();
              return pkgQueryResult();
            })
          : vi.spyOn(fs, "readFile").mockImplementationOnce(async (file, options) => {
              const contents = await readFile(file, options);
              await changeWrapper();
              return contents;
            });
      try {
        const result = await withMockedPlatform(
          stage === "pkg inspection" ? "freebsd" : "linux",
          () =>
            retireStandaloneGitWrapper({ previousRoot: root, searchDirs: [base], assertCurrent }),
        );
        if (change === "directory") {
          expect((await fs.lstat(wrapper)).isDirectory()).toBe(true);
        } else {
          await expect(fs.readFile(wrapper, "utf8")).resolves.toBe(
            change === "content change"
              ? replacement
              : change === "oversized file"
                ? "x".repeat(4097)
                : original,
          );
        }
        expect(result).toMatchObject({ error: expect.stringContaining("Could not retire") });
        expect(assertCurrent).toHaveBeenCalledTimes(change === "revoked finalizer" ? 1 : 0);
      } finally {
        observation.mockRestore();
      }
    });
  });

  it("preserves a pkg-owned legacy wrapper even when its contents match", async () => {
    await withTestDir({ prefix: "openclaw-wrapper-pkg-" }, async (base) => {
      const root = path.join(base, "old");
      const wrapper = path.join(base, "openclaw");
      const contents = `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${root}/dist/entry.js "$@"\n`;
      await fs.writeFile(wrapper, contents, { mode: 0o755 });
      const query = vi
        .spyOn(exec, "runCommandBuffered")
        .mockResolvedValue(pkgQueryResult(`${wrapper}\n`));
      try {
        await withMockedPlatform("freebsd", async () => {
          await expect(
            retireStandaloneGitWrapper({ previousRoot: root, searchDirs: [base] }),
          ).resolves.toMatchObject({ error: expect.stringContaining("owned by FreeBSD pkg") });
        });
        await expect(fs.readFile(wrapper, "utf8")).resolves.toBe(contents);
      } finally {
        query.mockRestore();
      }
    });
  });
  it("removes only the installer wrapper for the previous checkout", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrapper-retire-"));
    const oldRoot = path.join(home, "old checkout");
    const unrelatedWrapper = path.join(home, "earlier", "openclaw");
    const wrapper = path.join(home, ".local", "bin", "openclaw");
    const secondWrapper = path.join(home, "legacy", "bin", "openclaw");
    const oldWrapperContents = `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${oldRoot.replaceAll(" ", "\\ ")}/dist/entry.js "$@"\n`;
    await Promise.all([
      fs.mkdir(path.dirname(unrelatedWrapper), { recursive: true }),
      fs.mkdir(path.dirname(wrapper), { recursive: true }),
      fs.mkdir(path.dirname(secondWrapper), { recursive: true }),
    ]);
    await fs.writeFile(unrelatedWrapper, "#!/usr/bin/env bash\necho unrelated\n", { mode: 0o755 });
    await Promise.all([
      fs.writeFile(wrapper, oldWrapperContents, { mode: 0o755 }),
      fs.writeFile(secondWrapper, oldWrapperContents, { mode: 0o755 }),
    ]);
    try {
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "linux",
          searchDirs: [
            path.dirname(unrelatedWrapper),
            path.dirname(wrapper),
            path.dirname(secondWrapper),
          ],
        }),
      ).resolves.toEqual({});
      await expect(fs.readFile(unrelatedWrapper, "utf8")).resolves.toContain("unrelated");
      await expect(fs.stat(wrapper)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(secondWrapper)).rejects.toMatchObject({ code: "ENOENT" });

      await fs.writeFile(
        wrapper,
        "#!/usr/bin/env node\nimport '../lib/node_modules/openclaw/openclaw.mjs';\n",
        { mode: 0o755 },
      );
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "linux",
          searchDirs: [path.dirname(wrapper)],
        }),
      ).resolves.toEqual({});
      await expect(fs.stat(wrapper)).resolves.toBeDefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("removes only the exact PowerShell installer wrapper on Windows", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrapper-retire-win-"));
    const oldRoot = "C:\\Users\\operator\\openclaw";
    const wrapper = path.join(home, ".local", "bin", "openclaw.cmd");
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.writeFile(
      wrapper,
      `@echo off\r\nnode "${path.win32.join(oldRoot, "dist", "entry.js")}" %*\r\n`,
    );
    try {
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "win32",
          searchDirs: [path.dirname(wrapper)],
        }),
      ).resolves.toEqual({});
      await expect(fs.stat(wrapper)).rejects.toMatchObject({ code: "ENOENT" });

      await fs.writeFile(wrapper, "@echo off\r\necho unrelated\r\n");
      await expect(
        retireStandaloneGitWrapper({
          previousRoot: oldRoot,
          platform: "win32",
          searchDirs: [path.dirname(wrapper)],
        }),
      ).resolves.toEqual({});
      await expect(fs.readFile(wrapper, "utf8")).resolves.toContain("unrelated");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
