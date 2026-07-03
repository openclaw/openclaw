import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("./exec-approvals.js");

let commandRequiresOpenClawLifecycleApproval: typeof import("./exec-approvals.js").commandRequiresOpenClawLifecycleApproval;

async function loadActualExecApprovals(): Promise<void> {
  vi.resetModules();
  const execApprovals =
    await vi.importActual<typeof import("./exec-approvals.js")>("./exec-approvals.js");
  commandRequiresOpenClawLifecycleApproval = execApprovals.commandRequiresOpenClawLifecycleApproval;
}

describe("OpenClaw lifecycle exec approvals", () => {
  beforeEach(async () => {
    await loadActualExecApprovals();
  });

  it.each([
    {
      command: "openclaw uninstall --all --yes --non-interactive",
      argv: ["openclaw", "uninstall", "--all", "--yes", "--non-interactive"],
    },
    {
      command: "npx -y openclaw uninstall --all --yes --non-interactive",
      argv: ["npx", "-y", "openclaw", "uninstall", "--all", "--yes", "--non-interactive"],
    },
    {
      command: "npx --color always openclaw gateway restart",
      argv: ["npx", "--color", "always", "openclaw", "gateway", "restart"],
    },
    {
      command: "npx --future-option value openclaw gateway restart",
      argv: ["npx", "--future-option", "value", "openclaw", "gateway", "restart"],
    },
    {
      command: 'openclaw gateway "$(printf restart)"',
      argv: ["openclaw", "gateway", "$(printf restart)"],
    },
    {
      command: 'openclaw "$(printf gateway)" restart',
      argv: ["openclaw", "$(printf gateway)", "restart"],
    },
    {
      command: '"open$(printf claw)" gateway restart',
      argv: ["open$(printf claw)", "gateway", "restart"],
    },
    {
      command: 'openclaw gateway call "$(printf update.run)"',
      argv: ["openclaw", "gateway", "call", "$(printf update.run)"],
    },
    {
      command: "openclaw gateway --profile work restart",
      argv: ["openclaw", "gateway", "--profile", "work", "restart"],
    },
    {
      command: "openclaw gateway --no-color restart",
      argv: ["openclaw", "gateway", "--no-color", "restart"],
    },
    {
      command: "openclaw gateway install --force",
      argv: ["openclaw", "gateway", "install", "--force"],
    },
    {
      command: "openclaw daemon uninstall",
      argv: ["openclaw", "daemon", "uninstall"],
    },
    {
      command: "sudo systemctl restart openclaw-gateway.service",
      argv: ["sudo", "systemctl", "restart", "openclaw-gateway.service"],
    },
    {
      command: "sudo FOO=bar systemctl restart openclaw-gateway.service",
      argv: ["sudo", "FOO=bar", "systemctl", "restart", "openclaw-gateway.service"],
    },
    {
      command: "env PATH=/usr/bin launchctl stop gui/$UID/com.openclaw.gateway",
      argv: ["env", "PATH=/usr/bin", "launchctl", "stop", "gui/$UID/com.openclaw.gateway"],
    },
    {
      command: "pnpm -C repo openclaw gateway restart",
      argv: ["pnpm", "-C", "repo", "openclaw", "gateway", "restart"],
    },
    {
      command: "pnpm.cmd -C repo openclaw.cmd gateway restart",
      argv: ["pnpm.cmd", "-C", "repo", "openclaw.cmd", "gateway", "restart"],
    },
    {
      command: "corepack pnpm openclaw gateway restart",
      argv: ["corepack", "pnpm", "openclaw", "gateway", "restart"],
    },
    {
      command: 'schtasks /End /TN "OpenClaw Gateway"',
      argv: ["schtasks", "/End", "/TN", "OpenClaw Gateway"],
    },
    {
      command: 'schtasks.exe /Run /TN "OpenClaw Gateway"',
      argv: ["schtasks.exe", "/Run", "/TN", "OpenClaw Gateway"],
    },
    {
      command: 'schtasks /Delete /TN "OpenClaw Gateway" /F',
      argv: ["schtasks", "/Delete", "/TN", "OpenClaw Gateway", "/F"],
    },
    {
      command: 'eval "launchctl stop gui/$UID/com.openclaw.gateway"',
      argv: ["eval", "launchctl stop gui/$UID/com.openclaw.gateway"],
    },
    {
      command: 'env -S "systemctl --user restart openclaw-gateway.service"',
      argv: ["env", "-S", "systemctl --user restart openclaw-gateway.service"],
    },
    {
      command: 'sh -lc "launchctl stop gui/$UID/com.openclaw.gateway"',
      argv: ["sh", "-lc", "launchctl stop gui/$UID/com.openclaw.gateway"],
    },
    {
      command: 'sh -c "openclaw update --yes"',
      argv: ["sh", "-c", "openclaw update --yes"],
    },
    {
      command: "/usr/local/bin/opencla? gatewa? res?art",
      argv: ["/usr/local/bin/opencla?", "gatewa?", "res?art"],
    },
    {
      command: 'eval "true; openclaw update --yes"',
      argv: ["eval", "true; openclaw update --yes"],
    },
    {
      command: 'eval "true; openclaw --update"',
      argv: ["eval", "true; openclaw --update"],
    },
    {
      command: 'eval "true; openclaw uninstall --all --yes"',
      argv: ["eval", "true; openclaw uninstall --all --yes"],
    },
    {
      command: 'eval "true; openclaw gateway call update.run"',
      argv: ["eval", "true; openclaw gateway call update.run"],
    },
    {
      command: 'cmd.exe /d /s /c "schtasks /Run /TN \\"OpenClaw Gateway\\""',
      argv: ["cmd.exe", "/d", "/s", "/c", 'schtasks /Run /TN "OpenClaw Gateway"'],
    },
    {
      command: 'powershell.exe -NoProfile -Command "openclaw gateway restart"',
      argv: ["powershell.exe", "-NoProfile", "-Command", "openclaw gateway restart"],
    },
    {
      command: 'sh -c "openclaw gateway --force"',
      argv: ["sh", "-c", "openclaw gateway --force"],
    },
    {
      command: "timeout 5s openclaw gateway restart",
      argv: ["timeout", "5s", "openclaw", "gateway", "restart"],
    },
    {
      command: "timeout -sTERM 5s openclaw gateway restart",
      argv: ["timeout", "-sTERM", "5s", "openclaw", "gateway", "restart"],
    },
    {
      command: "timeout -f 5s openclaw gateway restart",
      argv: ["timeout", "-f", "5s", "openclaw", "gateway", "restart"],
    },
    {
      command: "timeout -p 5s openclaw gateway restart",
      argv: ["timeout", "-p", "5s", "openclaw", "gateway", "restart"],
    },
    {
      command: "/usr/bin/time -f%M openclaw gateway restart",
      argv: ["/usr/bin/time", "-f%M", "openclaw", "gateway", "restart"],
    },
    {
      command: '/usr/bin/time -f "" openclaw gateway restart',
      argv: ["/usr/bin/time", "-f", "", "openclaw", "gateway", "restart"],
    },
    {
      command: "/usr/bin/time -f --help openclaw gateway restart",
      argv: ["/usr/bin/time", "-f", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: "env -u --help openclaw gateway restart",
      argv: ["env", "-u", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: "env --argv0 --help /usr/bin/openclaw gateway restart",
      argv: ["env", "--argv0", "--help", "/usr/bin/openclaw", "gateway", "restart"],
    },
    {
      command: "env -a fake /usr/bin/openclaw gateway restart",
      argv: ["env", "-a", "fake", "/usr/bin/openclaw", "gateway", "restart"],
    },
    {
      command: "env --default-signal openclaw gateway restart",
      argv: ["env", "--default-signal", "openclaw", "gateway", "restart"],
    },
    {
      command: "env -v openclaw gateway restart",
      argv: ["env", "-v", "openclaw", "gateway", "restart"],
    },
    {
      command: "env --list-signal-handling openclaw gateway restart",
      argv: ["env", "--list-signal-handling", "openclaw", "gateway", "restart"],
    },
    {
      command: "env - openclaw gateway restart",
      argv: ["env", "-", "openclaw", "gateway", "restart"],
    },
    {
      command: 'env -S "FOO=bar openclaw gateway restart"',
      argv: ["env", "-S", "FOO=bar openclaw gateway restart"],
    },
    {
      command: "env -S '1=2 openclaw gateway restart'",
      argv: ["env", "-S", "1=2 openclaw gateway restart"],
    },
    {
      command: String.raw`env -S "X='a\'' openclaw gateway restart"`,
      argv: ["env", "-S", String.raw`X='a\'' openclaw gateway restart`],
    },
    {
      command: 'env -S "-u --help openclaw gateway restart"',
      argv: ["env", "-S", "-u --help openclaw gateway restart"],
    },
    {
      command: "env -S '-a \"\" openclaw gateway restart'",
      argv: ["env", "-S", '-a "" openclaw gateway restart'],
    },
    {
      command: "env -S '# ignored' openclaw gateway restart",
      argv: ["env", "-S", "# ignored", "openclaw", "gateway", "restart"],
    },
    {
      command: "env -S 'openclaw ${OC_AREA} ${OC_ACTION}'",
      argv: ["env", "-S", "openclaw ${OC_AREA} ${OC_ACTION}"],
    },
    {
      command: "env -u FOO -S 'openclaw ${OC_AREA} ${OC_ACTION}'",
      argv: ["env", "-u", "FOO", "-S", "openclaw ${OC_AREA} ${OC_ACTION}"],
    },
    {
      command: "env OC_BIN=openclaw env -S '${OC_BIN} gateway restart'",
      argv: ["env", "OC_BIN=openclaw", "env", "-S", "${OC_BIN} gateway restart"],
    },
    {
      command: "env CMD=openclaw env -S '${CMD} gateway restart'",
      argv: ["env", "CMD=openclaw", "env", "-S", "${CMD} gateway restart"],
    },
    {
      command: "env PNPM=pnpm env -S '${PNPM} -C repo openclaw gateway restart'",
      argv: ["env", "PNPM=pnpm", "env", "-S", "${PNPM} -C repo openclaw gateway restart"],
    },
    {
      command: "env -S '${OC_BIN} --profile work gateway restart'",
      argv: ["env", "-S", "${OC_BIN} --profile work gateway restart"],
    },
    {
      command: "env -S '${SYSTEMCTL} --user restart openclaw-gateway.service'",
      argv: ["env", "-S", "${SYSTEMCTL} --user restart openclaw-gateway.service"],
    },
    {
      command: "env -S '${EMPTY} systemctl --user restart openclaw-gateway.service'",
      argv: ["env", "-S", "${EMPTY} systemctl --user restart openclaw-gateway.service"],
    },
    {
      command: "env -S '${EMPTY}' openclaw gateway restart",
      argv: ["env", "-S", "${EMPTY}", "openclaw", "gateway", "restart"],
    },
    {
      command: "env -S '${EMPTY} -- openclaw gateway restart'",
      argv: ["env", "-S", "${EMPTY} -- openclaw gateway restart"],
    },
    {
      command: "env -S '${EMPTY} FOO=bar openclaw gateway restart'",
      argv: ["env", "-S", "${EMPTY} FOO=bar openclaw gateway restart"],
    },
    {
      command: "env -S '${EMPTY} nice -n 5 systemctl --user restart openclaw-gateway.service'",
      argv: ["env", "-S", "${EMPTY} nice -n 5 systemctl --user restart openclaw-gateway.service"],
    },
    {
      command: "env -S '${EMPTY}nice -n 5 systemctl --user restart openclaw-gateway.service'",
      argv: ["env", "-S", "${EMPTY}nice -n 5 systemctl --user restart openclaw-gateway.service"],
    },
    {
      command: "env -S 'nice ${EMPTY}-n 5 systemctl --user restart openclaw-gateway.service'",
      argv: ["env", "-S", "nice ${EMPTY}-n 5 systemctl --user restart openclaw-gateway.service"],
    },
    {
      command: 'env -S "" openclaw gateway restart',
      argv: ["env", "-S", "", "openclaw", "gateway", "restart"],
    },
    {
      command: String.raw`env -S "openclaw\_gateway\_restart"`,
      argv: ["env", "-S", String.raw`openclaw\_gateway\_restart`],
    },
    {
      command: String.raw`env -S 'sh -c "openclaw\_gateway\_restart"'`,
      argv: ["env", "-S", String.raw`sh -c "openclaw\_gateway\_restart"`],
    },
    {
      command: String.raw`env -S "openclaw\cignored" gateway restart`,
      argv: ["env", "-S", String.raw`openclaw\cignored`, "gateway", "restart"],
    },
    {
      command: "node /opt/openclaw/dist/index.js gateway restart",
      argv: ["node", "/opt/openclaw/dist/index.js", "gateway", "restart"],
    },
    {
      command: "npx --package openclaw openclaw gateway restart",
      argv: ["npx", "--package", "openclaw", "openclaw", "gateway", "restart"],
    },
    {
      command: "npx openclaw@latest gateway restart",
      argv: ["npx", "openclaw@latest", "gateway", "restart"],
    },
    {
      command: "npx openclaw@latest -- gateway restart",
      argv: ["npx", "openclaw@latest", "--", "gateway", "restart"],
    },
    {
      command: "pnpm dlx openclaw@2026.5.7 update --yes",
      argv: ["pnpm", "dlx", "openclaw@2026.5.7", "update", "--yes"],
    },
    {
      command: "pnpm dlx openclaw -- update --yes",
      argv: ["pnpm", "dlx", "openclaw", "--", "update", "--yes"],
    },
    {
      command: "bunx openclaw@latest uninstall --all --yes",
      argv: ["bunx", "openclaw@latest", "uninstall", "--all", "--yes"],
    },
    {
      command: "bunx openclaw@latest -- uninstall --all --yes",
      argv: ["bunx", "openclaw@latest", "--", "uninstall", "--all", "--yes"],
    },
    {
      command: "npm exec -c 'openclaw gateway restart'",
      argv: ["npm", "exec", "-c", "openclaw gateway restart"],
    },
    {
      command: "npm exec --loglevel silly -- openclaw gateway restart",
      argv: ["npm", "exec", "--loglevel", "silly", "--", "openclaw", "gateway", "restart"],
    },
    {
      command: "npm exec --future-option value -- openclaw gateway restart",
      argv: ["npm", "exec", "--future-option", "value", "--", "openclaw", "gateway", "restart"],
    },
    {
      command: "npx -c 'openclaw gateway restart'",
      argv: ["npx", "-c", "openclaw gateway restart"],
    },
    {
      command: String.raw`node C:\tools\openclaw\dist\entry.js daemon stop`,
      argv: ["node", String.raw`C:\tools\openclaw\dist\entry.js`, "daemon", "stop"],
    },
    {
      command: "exec -a display-name openclaw gateway restart",
      argv: ["exec", "-a", "display-name", "openclaw", "gateway", "restart"],
    },
    {
      command: "stdbuf -oL openclaw gateway restart",
      argv: ["stdbuf", "-oL", "openclaw", "gateway", "restart"],
    },
    {
      command: "/usr/bin/time -h openclaw gateway restart",
      argv: ["/usr/bin/time", "-h", "openclaw", "gateway", "restart"],
    },
    {
      command: "/usr/bin/time --portability openclaw gateway restart",
      argv: ["/usr/bin/time", "--portability", "openclaw", "gateway", "restart"],
    },
    {
      command: "nice -n 5 systemctl --user restart openclaw-gateway.service",
      argv: ["nice", "-n", "5", "systemctl", "--user", "restart", "openclaw-gateway.service"],
    },
    {
      command: "setsid openclaw gateway restart",
      argv: ["setsid", "openclaw", "gateway", "restart"],
    },
    {
      command: "setsid -fw openclaw gateway restart",
      argv: ["setsid", "-fw", "openclaw", "gateway", "restart"],
    },
    {
      command: "taskset 0x1 openclaw gateway restart",
      argv: ["taskset", "0x1", "openclaw", "gateway", "restart"],
    },
    {
      command: "ionice -c 2 -n 0 openclaw gateway restart",
      argv: ["ionice", "-c", "2", "-n", "0", "openclaw", "gateway", "restart"],
    },
    {
      command: "ionice -c2 -n0 openclaw gateway restart",
      argv: ["ionice", "-c2", "-n0", "openclaw", "gateway", "restart"],
    },
    {
      command: "chrt -f 50 systemctl --user restart openclaw-gateway.service",
      argv: ["chrt", "-f", "50", "systemctl", "--user", "restart", "openclaw-gateway.service"],
    },
    {
      command: "chrt -v -f 50 openclaw gateway restart",
      argv: ["chrt", "-v", "-f", "50", "openclaw", "gateway", "restart"],
    },
    {
      command: "chrt -Rf 50 systemctl --user restart openclaw-gateway.service",
      argv: ["chrt", "-Rf", "50", "systemctl", "--user", "restart", "openclaw-gateway.service"],
    },
    {
      command: "chrt -o openclaw gateway restart",
      argv: ["chrt", "-o", "openclaw", "gateway", "restart"],
    },
    {
      command: "chrt -o 0 openclaw gateway restart",
      argv: ["chrt", "-o", "0", "openclaw", "gateway", "restart"],
    },
    {
      command: "chrt -o systemctl --user restart openclaw-gateway.service",
      argv: ["chrt", "-o", "systemctl", "--user", "restart", "openclaw-gateway.service"],
    },
    {
      command: "flock /tmp/oc.lock -c 'systemctl --user restart openclaw-gateway.service'",
      argv: ["flock", "/tmp/oc.lock", "-c", "systemctl --user restart openclaw-gateway.service"],
    },
    {
      command: "CMD=openclaw flock /tmp/oc.lock -c 'env -S \"${CMD} gateway restart\"'",
      argv: ["flock", "/tmp/oc.lock", "-c", 'env -S "${CMD} gateway restart"'],
    },
    {
      command: "flock /tmp/oc.lock -c 'CMD=op\\enclaw env -S \"${CMD} gateway restart\"'",
      argv: ["flock", "/tmp/oc.lock", "-c", 'CMD=op\\enclaw env -S "${CMD} gateway restart"'],
    },
    {
      command: "printf x | xargs -I{} openclaw gateway restart",
      argv: ["xargs", "-I{}", "openclaw", "gateway", "restart"],
    },
    {
      command: "printf openclaw | xargs -I{} {} gateway restart",
      argv: ["xargs", "-I{}", "{}", "gateway", "restart"],
    },
    {
      command: "printf gateway | xargs --replace={} openclaw {} restart",
      argv: ["xargs", "--replace={}", "openclaw", "{}", "restart"],
    },
    {
      command: "printf restart | xargs -I {} openclaw gateway {}",
      argv: ["xargs", "-I", "{}", "openclaw", "gateway", "{}"],
    },
    {
      command: "printf openclaw.service | xargs -i systemctl restart {}",
      argv: ["xargs", "-i", "systemctl", "restart", "{}"],
    },
    {
      command: "printf x | xargs --max-args=1 openclaw gateway restart",
      argv: ["xargs", "--max-args=1", "openclaw", "gateway", "restart"],
    },
    {
      command: "printf 'gateway restart\\n' | xargs openclaw",
      argv: ["xargs", "openclaw"],
    },
    {
      command: "printf 'restart openclaw-gateway.service\\n' | xargs systemctl",
      argv: ["xargs", "systemctl"],
    },
    {
      command: "printf '%s\\0' 'openclaw gateway restart' | xargs -0 sh -c",
      argv: ["xargs", "-0", "sh", "-c"],
    },
    {
      command: "env env env env env openclaw gateway restart",
      argv: ["env", "env", "env", "env", "env", "openclaw", "gateway", "restart"],
    },
    {
      command: "sh -c 'CMD=openclaw; $CMD update --yes'",
      argv: ["sh", "-c", "CMD=openclaw; $CMD update --yes"],
    },
    {
      command: "sh -c 'CMD=openclaw; $CMD uninstall --yes'",
      argv: ["sh", "-c", "CMD=openclaw; $CMD uninstall --yes"],
    },
    {
      command: "sh -c 'CMD=openclaw; $CMD gateway call update.run'",
      argv: ["sh", "-c", "CMD=openclaw; $CMD gateway call update.run"],
    },
    {
      command: `${"env ".repeat(33)}openclaw update --yes`,
      argv: [...Array(33).fill("env"), "openclaw", "update", "--yes"],
    },
    {
      command: `${"env ".repeat(33)}openclaw uninstall --yes`,
      argv: [...Array(33).fill("env"), "openclaw", "uninstall", "--yes"],
    },
    {
      command: `${"env ".repeat(33)}openclaw gateway call update.run`,
      argv: [...Array(33).fill("env"), "openclaw", "gateway", "call", "update.run"],
    },
    {
      command: "find . -exec openclaw gateway restart {} ;",
      argv: ["find", ".", "-exec", "openclaw", "gateway", "restart", "{}", ";"],
    },
    {
      command: "find . -execdir sh -c 'systemctl --user restart openclaw-gateway.service' ;",
      argv: [
        "find",
        ".",
        "-execdir",
        "sh",
        "-c",
        "systemctl --user restart openclaw-gateway.service",
        ";",
      ],
    },
    {
      command: "systemctl --user freeze openclaw-gateway.service",
      argv: ["systemctl", "--user", "freeze", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --user thaw openclaw-gateway.service",
      argv: ["systemctl", "--user", "thaw", "openclaw-gateway.service"],
    },
    {
      command: "sasv OpenClaw",
      argv: ["sasv", "OpenClaw"],
    },
    {
      command: "gsv OpenClaw | spsv",
      argv: ["gsv", "OpenClaw"],
    },
    {
      command: "sh -c '(openclaw update --yes)'",
      argv: ["sh", "-c", "(openclaw update --yes)"],
    },
    {
      command: "openclaw gateway --port 18789 --profile work restart",
      argv: ["openclaw", "gateway", "--port", "18789", "--profile", "work", "restart"],
    },
    {
      command: `echo "'$(openclaw update --yes)"`,
      argv: ["echo", "'$(openclaw update --yes)"],
    },
    {
      command: "cat <(openclaw update --yes)",
      argv: ["cat", "<(openclaw", "update", "--yes)"],
    },
    {
      command: "cat =(openclaw update --yes)",
      argv: ["cat", "=(openclaw", "update", "--yes)"],
    },
    {
      command: "f() { openclaw update --yes; }; f",
      argv: ["f()", "{", "openclaw", "update", "--yes"],
    },
    {
      command: "f() { openclaw update --yes; }; printf x | f",
      argv: ["f()", "{", "openclaw", "update", "--yes"],
    },
    {
      command: "f() { g; }; g() { openclaw update --yes; }; f",
      argv: ["f()", "{", "g"],
    },
    {
      command: "if true; then openclaw update --yes; fi",
      argv: ["if", "true"],
    },
    {
      command: "! openclaw update --yes",
      argv: ["!", "openclaw", "update", "--yes"],
    },
    {
      command: "sh -c 'case x in x) openclaw update --yes;; esac'",
      argv: ["sh", "-c", "case x in x) openclaw update --yes;; esac"],
    },
    {
      command: 'cmd.exe /d /s /c "echo # & openclaw update --yes"',
      argv: ["cmd.exe", "/d", "/s", "/c", "echo # & openclaw update --yes"],
    },
    {
      command: 'cmd.exe /d /s /c "open^claw gateway res^tart"',
      argv: ["cmd.exe", "/d", "/s", "/c", "open^claw gateway res^tart"],
    },
    {
      command:
        'cmd.exe /d /v:on /c "echo x\'&set A=open&set B=claw&set C=!A!!B!&!C! gateway restart"',
      argv: [
        "cmd.exe",
        "/d",
        "/v:on",
        "/c",
        "echo x'&set A=open&set B=claw&set C=!A!!B!&!C! gateway restart",
      ],
    },
  ])("requires explicit approval for OpenClaw lifecycle command %j", ({ command, argv }) => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [{ raw: command, argv }],
      }),
    ).toBe(true);
  });
});
