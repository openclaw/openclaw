import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { readStandaloneInstaller } from "../../scripts/lib/standalone-installers.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";

it.each([
  { cold: true, beta: true, strict: false },
  { cold: false, beta: true, strict: false },
  { cold: true, beta: false, strict: false },
  { cold: true, beta: true, strict: true },
])(
  "admits the selected --beta target with $cold cold, $beta beta, $strict strict",
  async (testCase) => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-install-beta-"));
    const latest = "2026.10.9";
    const beta = "2026.10.10-beta.5";
    const floor = ">=24.22.1 <25 || >=26.12.1";
    // Above the running native Node: reaching package installation would violate admission.
    const strictEngine = `>=${Number(process.versions.node.split(".")[0]) + 1}.0.0`;
    const registry = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: "openclaw",
          "dist-tags": { latest, ...(testCase.beta ? { beta } : {}) },
          versions: {
            [latest]: { name: "openclaw", version: latest, engines: { node: floor } },
            [beta]: {
              name: "openclaw",
              version: beta,
              engines: { node: testCase.strict ? strictEngine : floor },
            },
          },
        }),
      );
    });
    try {
      await new Promise<void>((resolve) => {
        registry.listen(0, "127.0.0.1", resolve);
      });
      const address = registry.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing registry port");
      }
      const bin = join(root, "bin");
      mkdirSync(bin);
      symlinkSync(requireNodeTool("node"), join(bin, "node"));
      symlinkSync(
        join(dirname(createRequire(import.meta.url).resolve("npm/package.json")), "bin/npm-cli.js"),
        join(bin, "npm"),
      );
      const installer = join(root, "install.sh");
      writeFileSync(installer, readStandaloneInstaller(process.cwd(), "install.sh"));
      const child = spawn(
        "/bin/bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `
      source "$INSTALLER"
      bootstrap_gum_temp() { :; }; print_installer_banner() { :; }; print_gum_status() { :; }
      detect_os_or_die() { OS=macos; }; detect_openclaw_checkout() { return 1; }
      check_existing_openclaw() { return 1; }
      promote_supported_node_binary() { return 1; }
      install_homebrew() { :; }
      install_node() { echo 'PROVISION_NODE'; export PATH="$FIXTURE_BIN:/usr/bin:/bin"; hash -r; }
      check_git() { return 0; }; fix_npm_permissions() { :; }
      prepare_git_wrapper_backup_for_npm() { :; }
      install_openclaw_npm() { printf 'ACTUAL_INSTALL_SPEC=%s\\n' "$1"; exit 86; }
      parse_args --install-method npm --beta --no-onboard --no-prompt
      configure_verbose
      main
    `,
        ],
        {
          env: {
            HOME: root,
            OPENCLAW_STATE_DIR: join(root, "state"),
            TMPDIR: root,
            PATH: `${testCase.cold ? "" : `${bin}:`}/usr/bin:/bin`,
            INSTALLER: installer,
            FIXTURE_BIN: bin,
            OPENCLAW_INSTALL_SH_NO_RUN: "1",
            NPM_CONFIG_REGISTRY: `http://127.0.0.1:${address.port}`,
            NPM_CONFIG_CACHE: join(root, "cache"),
            NPM_CONFIG_USERCONFIG: join(root, "npmrc"),
            NPM_CONFIG_GLOBALCONFIG: join(root, "global-npmrc"),
            TERM: "dumb",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code, output).toBe(testCase.strict ? 1 : 86);
      if (testCase.strict) {
        expect(output).toContain(`Active Node.js must be ${strictEngine}`);
        expect(output).not.toContain("ACTUAL_INSTALL_SPEC=");
      } else {
        expect(output).toContain(`ACTUAL_INSTALL_SPEC=openclaw@${testCase.beta ? beta : "latest"}`);
      }
      expect(output.includes("PROVISION_NODE")).toBe(testCase.cold);
      if (!testCase.beta) {
        expect(output).toMatch(/![^\n]*[Bb]eta[^\n]*latest/);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        registry.close((error) => (error ? reject(error) : resolve()));
      });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
