import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "tsdown";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import buildConfigs from "../../tsdown.config.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const execFileAsync = promisify(execFile);

it.skipIf(process.platform === "win32")(
  "packages a relocated GitLab resolver with the native security helper",
  async () => {
    const selected = buildConfigs.find(
      (config) =>
        typeof config.entry === "object" &&
        config.entry !== null &&
        !Array.isArray(config.entry) &&
        "worker/gitlab-exec-launcher" in config.entry,
    );
    if (!selected) {
      throw new Error("Missing GitLab exec launcher build config");
    }
    const root = fs.realpathSync(createTempDir("gitlab-launcher-build-"));
    const output = path.join(root, "build");
    const { bundles } = await build({
      ...selected,
      config: false,
      outDir: output,
      dts: false,
      logLevel: "silent",
    });
    try {
      const relocated = path.join(root, "relocated");
      fs.renameSync(output, relocated);
      const entry = path.join(relocated, "worker", "gitlab-exec-launcher.mjs");
      const helper = path.join(path.dirname(entry), "windows-security-helper.exe");
      expect(fs.readFileSync(helper).subarray(0, 2).toString("ascii")).toBe("MZ");

      const profile = path.join(root, "profile");
      fs.mkdirSync(profile, { mode: 0o700 });
      fs.writeFileSync(
        path.join(profile, "config.yml"),
        "hosts:\n  gitlab.example.test:\n    token: synthetic-relocated-token\n",
        { mode: 0o600 },
      );
      const { stdout, stderr } = await execFileAsync(
        resolveTestNodeExecPath(),
        [entry, profile, "https://gitlab.example.test"],
        { cwd: root, env: { PATH: process.env.PATH, FS_SAFE_NATIVE_MODE: "off" } },
      );
      expect({ stdout, stderr }).toEqual({ stdout: "synthetic-relocated-token", stderr: "" });
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  },
);
