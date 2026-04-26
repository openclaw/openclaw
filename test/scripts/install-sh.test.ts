import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/install.sh";

describe("install.sh apt behavior", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  it("runs apt-get through noninteractive wrappers", () => {
    expect(script).toContain("apt_get()");
    expect(script).toContain('DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"');
    expect(script).toContain('NEEDRESTART_MODE="${NEEDRESTART_MODE:-a}"');
    expect(script).toContain("sudo env DEBIAN_FRONTEND=");
    expect(script).toContain("-o Dpkg::Options::=--force-confdef");
    expect(script).toContain("-o Dpkg::Options::=--force-confold");

    const rawAptInstalls = script
      .split("\n")
      .filter((line) => /\b(?:sudo\s+)?apt-get\s+install\b/.test(line));
    expect(rawAptInstalls).toEqual([]);
  });

  it("exports noninteractive apt env during Linux startup", () => {
    expect(script).toMatch(
      /detect_os_or_die\s+if \[\[ "\$OS" == "linux" \]\]; then\s+export DEBIAN_FRONTEND="\$\{DEBIAN_FRONTEND:-noninteractive\}"\s+export NEEDRESTART_MODE="\$\{NEEDRESTART_MODE:-a\}"\s+fi/m,
    );
    expect(script).toContain(
      'run_quiet_step "Configuring NodeSource repository" sudo -E bash "$tmp"',
    );
  });
});
