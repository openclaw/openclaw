import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeStandaloneInstallers } from "../../scripts/lib/standalone-installers.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const source = '#!/bin/bash\nsource "${BASH_SOURCE[0]%${BASH_SOURCE[0]##*/}}./install-policy.sh"\n';
const shellEnv = (root: string) => ({ PATH: process.env.PATH, HOME: root, BASH_ENV: "", ENV: "" });
function write(root: string, name: string, content: string) {
  writeFileSync(path.join(root, name), content);
}
function bash(root: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: Buffer) {
  return spawnSync("/bin/bash", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...shellEnv(root), ...env },
    input,
  });
}

describe("standalone shell installers", () => {
  it.each(["scripts", "install.sh", "install-policy.sh"])(
    "rejects candidate-controlled %s symlinks instead of embedding host data",
    (target) => {
      const root = tempDirs.make("installer-source-symlink-");
      const candidate = path.join(root, "candidate");
      const outside = path.join(root, "outside");
      const output = path.join(root, "output");
      mkdirSync(candidate);
      mkdirSync(outside);
      if (target === "scripts") {
        write(outside, "install.sh", source);
        symlinkSync(outside, path.join(candidate, "scripts"), "dir");
      } else {
        const scripts = path.join(candidate, "scripts");
        mkdirSync(scripts);
        write(outside, "host-data", "synthetic-host-data\n");
        if (target !== "install.sh") {
          write(scripts, "install.sh", source);
        }
        symlinkSync(path.join(outside, "host-data"), path.join(scripts, target));
      }
      expect(() => writeStandaloneInstallers(candidate, output)).toThrow(
        "Installer source cannot contain symlinks",
      );
      expect(readdirSync(output)).toEqual([]);
    },
  );

  it("uses trusted assembly for a separate smoke candidate and cleans up failed assembly", () => {
    const root = tempDirs.make("installer-smoke-assembly-");
    const candidate = path.join(root, "candidate");
    const scripts = path.join(candidate, "scripts");
    mkdirSync(scripts, { recursive: true });
    for (const name of ["install.sh", "install-cli.sh"]) {
      write(scripts, name, source);
    }
    write(scripts, "build-installers.mjs", 'throw new Error("candidate generator executed");\n');
    const run = () =>
      bash(root, [path.resolve("scripts/test-install-sh-docker.sh")], {
        TMPDIR: root,
        OPENCLAW_INSTALL_SMOKE_SOURCE_DIR: candidate,
        OPENCLAW_INSTALL_SMOKE_GROUP: "update",
        OPENCLAW_INSTALL_SMOKE_SKIP_IMAGE_BUILD: "1",
        OPENCLAW_INSTALL_SMOKE_SKIP_UPDATE: "1",
        OPENCLAW_INSTALL_SMOKE_SKIP_FRESHNESS: "1",
      });
    const missing = run();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("install-policy.sh");
    expect(missing.stderr).not.toContain("candidate generator executed");
    expect(readdirSync(root)).toEqual(["candidate"]);
    write(scripts, "install-policy.sh", "policy() { return 0; }\n");
    const assembled = run();
    expect(assembled.status, assembled.stdout + assembled.stderr).toBe(0);
    expect(readdirSync(root)).toEqual(["candidate"]);
  });

  it.each(["install.sh", "install-cli.sh"])(
    "runs %s outside the checkout as a file and stdin without a policy download",
    (name) => {
      const root = tempDirs.make("standalone-installer-");
      writeStandaloneInstallers(process.cwd(), root);
      const script = path.join(root, name);
      const env = {
        TERM: "dumb",
        OPENCLAW_TAGLINE_INDEX: "0",
      };
      for (const args of [
        [script, "--help"],
        ["-s", "--", "--help"],
      ]) {
        const result = bash(root, args, env, readFileSync(script));
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("--install-method");
        expect(result.stdout).toContain("Support: https://community.openclaw.ai/");
        expect(result.stdout).toContain("FAQ: https://docs.openclaw.ai/start/faq");
      }
      write(root, ".npmrc", "min-release-age=7\n");
      const policy = bash(
        root,
        [
          "-c",
          'source "$1"; npm_config_file_has_key .npmrc min-release-age; git_install_lockfile_flag moving',
          "probe",
          script,
        ],
        { ...env, OPENCLAW_INSTALL_SH_NO_RUN: "1", OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1" },
      );
      expect(policy.status, policy.stdout + policy.stderr).toBe(0);
      expect(policy.stdout).toBe("--no-frozen-lockfile\n");
    },
  );
});
