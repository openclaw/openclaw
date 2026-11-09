import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readStandaloneInstaller } from "../../scripts/lib/standalone-installers.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each(["npm", "git"])("%s Node provisioning", (installMethod) => {
  it.each([
    { verbose: 0, bootstrapExit: 17 },
    { verbose: 1, bootstrapExit: 17 },
    { verbose: 0, bootstrapExit: 0 },
    { verbose: 1, bootstrapExit: 0 },
  ])(
    "settles Homebrew bootstrap before Node provisioning (verbose=$verbose, exit=$bootstrapExit)",
    ({ verbose, bootstrapExit }) => {
      const home = tempDirs.make("openclaw-install-provisioning-");
      const installer = join(home, "install.sh");
      writeFileSync(installer, readStandaloneInstaller(process.cwd(), "install.sh"));
      mkdirSync(join(home, "state"));
      mkdirSync(join(home, "checkout", ".git"), { recursive: true });
      const result = spawnSync(
        "/bin/bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `source "$1"
        INSTALL_METHOD=${installMethod}; NO_ONBOARD=1; NO_PROMPT=1; VERBOSE=${verbose}; GUM=""
        GIT_DIR="$HOME/checkout"; GIT_DIR_EXPLICIT=1
        bootstrap_gum_temp() { :; }; print_installer_banner() { :; }; print_gum_status() { :; }
        detect_os_or_die() { OS=macos; }; detect_openclaw_checkout() { return 1; }
        show_install_plan() { :; }; check_existing_openclaw() { return 1; }
        validate_git_checkout() { return 0; }; resolve_git_openclaw_ref() { printf 'main\\n'; }
        git() { if [[ "$*" == *status* ]]; then printf ' M package.json\\n'; else return 0; fi; }
        load_nvm_for_node_detection() { NVM_DETECTED=0; }
        resolve_node_package_engine() { :; }
        use_supported_nvm_node() { return 1; }; promote_supported_node_binary() { return 1; }
        node() { if [[ "$1" == -v ]]; then printf 'v20.0.0\\n'; else return 91; fi; }
        command() {
          if [[ "$*" == '-v brew' ]]; then return 1; fi
          builtin command "$@"
        }
        is_macos_admin_user() { return 0; }
        run_remote_bash() { printf 'controlled Homebrew bootstrap exit:${bootstrapExit}\\n' >&2; return ${bootstrapExit}; }
        brew() { printf 'refused brew:%s\\n' "$*" >&2; return 29; }
        main
        printf 'unexpected installer continuation\\n'
        `,
          "installer-probe",
          installer,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            OPENCLAW_STATE_DIR: join(home, "state"),
            TMPDIR: home,
            BASH_ENV: "",
            ENV: "",
            OPENCLAW_INSTALL_SH_NO_RUN: "1",
          },
        },
      );
      const output = stripVTControlCharacters(result.stdout + result.stderr);
      expect(result.error).toBeUndefined();
      expect(result.status, output).toBe(bootstrapExit || 1);
      expect(output).not.toContain("unexpected installer continuation");
      expect(output).not.toContain("Node.js installed");
      if (bootstrapExit) {
        expect(output).toContain("controlled Homebrew bootstrap exit:17");
        expect(output).not.toContain("Homebrew installed");
        expect(output).not.toContain("Installing Node.js via Homebrew");
        expect(output).not.toContain("refused brew:");
      } else {
        expect(output).toContain("Homebrew installed");
        expect(output).toContain("refused brew:install node");
        expect(output).not.toContain("refused brew:link");
      }
    },
  );
});
