import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { matchesStandaloneGitWrapper } from "./update-git-launcher.js";

it.each(["missing", "different", "retargeted"])(
  "refuses a Windows wrapper whose Node executable is %s",
  async (condition) => {
    await withTestDir({ prefix: "update-windows-node-" }, async (base) => {
      const node = path.join(base, "node.exe");
      const root = "C:\\OpenClaw\\source";
      const wrapper = `@echo off\r\nnode "${path.win32.join(root, "dist", "entry.js")}" %*\r\n`;
      if (condition === "different") {
        await fs.writeFile(node, "custom executable\n");
      }
      if (condition === "retargeted") {
        await fs.symlink(process.execPath, node);
      }
      await withEnvAsync({ PATH: base, PATHEXT: ".EXE" }, () =>
        withMockedPlatform("win32", async () => {
          if (condition === "retargeted") {
            await expect(
              matchesStandaloneGitWrapper(wrapper, root, "win32", process.execPath),
            ).resolves.toBe(true);
            await fs.unlink(node);
            await fs.writeFile(node, "replacement executable\n");
          }
          await expect(
            matchesStandaloneGitWrapper(wrapper, root, "win32", process.execPath),
          ).resolves.toBe(false);
        }),
      );
    });
  },
);
