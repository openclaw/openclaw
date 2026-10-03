import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeStandaloneInstallers } from "../../scripts/lib/standalone-installers.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
      const source =
        '#!/bin/bash\nsource "${BASH_SOURCE[0]%${BASH_SOURCE[0]##*/}}./install-policy.sh"\n';
      if (target === "scripts") {
        writeFileSync(path.join(outside, "install.sh"), source);
        symlinkSync(outside, path.join(candidate, "scripts"), "dir");
      } else {
        const scripts = path.join(candidate, "scripts");
        mkdirSync(scripts);
        writeFileSync(path.join(outside, "host-data"), "synthetic-host-data\n");
        if (target !== "install.sh") {
          writeFileSync(path.join(scripts, "install.sh"), source);
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
      writeFileSync(
        path.join(scripts, name),
        '#!/bin/bash\nsource "${BASH_SOURCE[0]%${BASH_SOURCE[0]##*/}}./install-policy.sh"\n',
      );
    }
    writeFileSync(
      path.join(scripts, "build-installers.mjs"),
      'throw new Error("candidate generator executed");\n',
    );
    const run = () =>
      spawnSync("/bin/bash", [path.resolve("scripts/test-install-sh-docker.sh")], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          BASH_ENV: "",
          ENV: "",
          OPENCLAW_INSTALL_SMOKE_SOURCE_DIR: candidate,
          OPENCLAW_INSTALL_SMOKE_GROUP: "update",
          OPENCLAW_INSTALL_SMOKE_SKIP_IMAGE_BUILD: "1",
          OPENCLAW_INSTALL_SMOKE_SKIP_UPDATE: "1",
          OPENCLAW_INSTALL_SMOKE_SKIP_FRESHNESS: "1",
        },
      });
    const missing = run();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("install-policy.sh");
    expect(missing.stderr).not.toContain("candidate generator executed");
    expect(readdirSync(root)).toEqual(["candidate"]);
    writeFileSync(path.join(scripts, "install-policy.sh"), "policy() { return 0; }\n");
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
        PATH: process.env.PATH,
        HOME: root,
        TERM: "dumb",
        BASH_ENV: "",
        ENV: "",
        OPENCLAW_TAGLINE_INDEX: "0",
      };
      for (const args of [
        [script, "--help"],
        ["-s", "--", "--help"],
      ]) {
        const result = spawnSync("/bin/bash", args, {
          cwd: root,
          input: readFileSync(script),
          encoding: "utf8",
          env,
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("--install-method");
      }
      writeFileSync(path.join(root, ".npmrc"), "min-release-age=7\n");
      const policy = spawnSync(
        "/bin/bash",
        [
          "-c",
          'source "$1"; npm_config_file_has_key .npmrc min-release-age; git_install_lockfile_flag moving',
          "probe",
          script,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...env, OPENCLAW_INSTALL_SH_NO_RUN: "1", OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1" },
        },
      );
      expect(policy.status, policy.stdout + policy.stderr).toBe(0);
      expect(policy.stdout).toBe("--no-frozen-lockfile\n");
    },
  );
});
