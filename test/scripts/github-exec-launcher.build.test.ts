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

// Execute the real relocated launcher on POSIX; only the Windows OS helper is
// emulated. Its identity comes from the helper response, not USERNAME/USERSID.
it.skipIf(process.platform === "win32")(
  "reads private Windows credentials without a package tree or identity environment",
  async () => {
    const selected = buildConfigs.find(
      (config) =>
        typeof config.entry === "object" &&
        config.entry !== null &&
        !Array.isArray(config.entry) &&
        "worker/github-exec-launcher" in config.entry,
    );
    if (!selected) {
      throw new Error("Missing GitHub exec launcher build config");
    }
    const root = fs.realpathSync(createTempDir("github-launcher-build-"));
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
      const entry = path.join(relocated, "worker", "github-exec-launcher.mjs");
      const profile = path.join(root, "profile");
      fs.mkdirSync(profile);
      fs.writeFileSync(
        path.join(profile, "hosts.yml"),
        "github.com:\n  oauth_token: synthetic-relocated-token\n",
      );
      const bootstrap = path.join(root, "windows.mjs");
      fs.writeFileSync(
        bootstrap,
        'Object.defineProperty(process, "platform", { value: "win32" });',
      );
      const node = resolveTestNodeExecPath();
      const helper = path.join(path.dirname(entry), "windows-security-helper.exe");
      const helperHeader = fs.existsSync(helper)
        ? fs.readFileSync(helper).subarray(0, 2)
        : undefined;
      fs.writeFileSync(
        helper,
        `#!${node}
const fs = require("node:fs");
const sid = "s-1-5-21-111-222-333-1001";
const sids = [sid, "s-1-5-18", "s-1-5-32-544", ...(process.env.SYNTHETIC_WORLD_SID ? [process.env.SYNTHETIC_WORLD_SID] : [])];
const flags = { raw: 3, objectInherit: true, containerInherit: true, noPropagateInherit: false, inheritOnly: false, inherited: false, successfulAccess: false, failedAccess: false };
if (process.argv[2] === "owner") {
  process.stdout.write(JSON.stringify({ ownerSid: sid, currentUserSid: sid, remote: false, complete: true, daclPresent: true, aces: sids.map(sid => ({ sid, mask: 0x1f01ff, deny: false, inheritOnly: false })) }));
} else {
  const stat = fs.fstatSync(0, { bigint: true });
  process.stdout.write(JSON.stringify({ ok: true, result: {
    identity: stat.dev.toString(16).padStart(8, "0") + ":" + stat.ino.toString(16).padStart(16, "0"),
    security: { ownerSid: sid, currentUserSid: sid, daclPresent: true, daclProtected: true, isLocal: true, aceListComplete: true, unsupportedAceTypes: [], aces: sids.map(sid => ({ sid, mask: 0x1f01ff, aceType: "allow", flags })) }
  }}));
}
`,
        { mode: 0o755 },
      );
      fs.chmodSync(helper, 0o755);
      const run = (extraEnv: NodeJS.ProcessEnv = {}) =>
        execFileAsync(node, ["--import", bootstrap, entry, profile, "github.com"], {
          cwd: root,
          env: { PATH: process.env.PATH, FS_SAFE_NATIVE_MODE: "off", ...extraEnv },
        });
      for (const identity of [
        {},
        { USERNAME: "crabbox", USERDOMAIN: "WORKER", USERSID: "S-1-5-21-111-222-333-1001" },
      ]) {
        expect((await run(identity)).stdout).toBe("synthetic-relocated-token");
      }
      for (const sid of ["s-1-1-0", "s-1-5-32-545", "s-1-5-11"]) {
        await expect(run({ SYNTHETIC_WORLD_SID: sid })).rejects.toMatchObject({
          code: 1,
          stdout: "",
          stderr: expect.stringContaining("GitHub Identity credential is unavailable or insecure"),
        });
      }
      expect(helperHeader?.toString("ascii")).toBe("MZ");
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  },
);
