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
      command: "launchctl print gui/$UID/com.openclaw.gateway",
      argv: ["launchctl", "print", "gui/$UID/com.openclaw.gateway"],
    },
    {
      command: "systemctl --user status openclaw-gateway.service",
      argv: ["systemctl", "--user", "status", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --help restart openclaw-gateway.service",
      argv: ["systemctl", "--help", "restart", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --version restart openclaw-gateway.service",
      argv: ["systemctl", "--version", "restart", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --type service status openclaw-gateway.service",
      argv: ["systemctl", "--type", "service", "status", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --signal=0 kill openclaw-gateway.service",
      argv: ["systemctl", "--signal=0", "kill", "openclaw-gateway.service"],
    },
    {
      command: "systemctl -s0 kill openclaw-gateway.service",
      argv: ["systemctl", "-s0", "kill", "openclaw-gateway.service"],
    },
    {
      command: "sudo systemctl --signal=0 kill openclaw-gateway.service",
      argv: ["sudo", "systemctl", "--signal=0", "kill", "openclaw-gateway.service"],
    },
    {
      command: "systemctl status restart openclaw-gateway.service",
      argv: ["systemctl", "status", "restart", "openclaw-gateway.service"],
    },
    {
      command: "openclaw update status --json --timeout 9",
      argv: ["openclaw", "update", "status", "--json", "--timeout", "9"],
    },
    {
      command: "openclaw update --dry-run --channel beta",
      argv: ["openclaw", "update", "--dry-run", "--channel", "beta"],
    },
    {
      command: "openclaw --update status --json",
      argv: ["openclaw", "--update", "status", "--json"],
    },
    {
      command: "openclaw --update --dry-run --channel beta",
      argv: ["openclaw", "--update", "--dry-run", "--channel", "beta"],
    },
    {
      command: "openclaw update --help",
      argv: ["openclaw", "update", "--help"],
    },
    {
      command: "openclaw update repair --help",
      argv: ["openclaw", "update", "repair", "--help"],
    },
    {
      command: "openclaw uninstall --dry-run --all",
      argv: ["openclaw", "uninstall", "--dry-run", "--all"],
    },
    {
      command: "openclaw uninstall --help",
      argv: ["openclaw", "uninstall", "--help"],
    },
    {
      command: 'sh -c "openclaw update --dry-run --channel beta"',
      argv: ["sh", "-c", "openclaw update --dry-run --channel beta"],
    },
    {
      command: 'eval "true; openclaw update status --json"',
      argv: ["eval", "true; openclaw update status --json"],
    },
    {
      command: 'eval "true; openclaw gateway call update.status"',
      argv: ["eval", "true; openclaw gateway call update.status"],
    },
    {
      command: "sudo systemctl status openclaw-gateway.service",
      argv: ["sudo", "systemctl", "status", "openclaw-gateway.service"],
    },
    {
      command: "pidof openclaw",
      argv: ["pidof", "openclaw"],
    },
    {
      command: "kill 12345",
      argv: ["kill", "12345"],
    },
    {
      command: 'kill -0 "$(pidof openclaw)"',
      argv: ["kill", "-0", "$(pidof openclaw)"],
    },
    {
      command: 'kill -s0 "$(pidof openclaw)"',
      argv: ["kill", "-s0", "$(pidof openclaw)"],
    },
    {
      command: "kill --signal=0 $(pgrep -f '[o]penclaw')",
      argv: ["kill", "--signal=0", "$(pgrep", "-f", "'[o]penclaw')"],
    },
    {
      command: "pkill -0 openclaw",
      argv: ["pkill", "-0", "openclaw"],
    },
    {
      command: "pkill --help openclaw",
      argv: ["pkill", "--help", "openclaw"],
    },
    {
      command: "kill --help openclaw",
      argv: ["kill", "--help", "openclaw"],
    },
    {
      command: "kill openclaw",
      argv: ["kill", "openclaw"],
    },
    {
      command: "Stop-Process OpenClaw",
      argv: ["Stop-Process", "OpenClaw"],
    },
    {
      command: "kill -l openclaw",
      argv: ["kill", "-l", "openclaw"],
    },
    {
      command: "killall --list openclaw",
      argv: ["killall", "--list", "openclaw"],
    },
    {
      command: "taskkill /? openclaw",
      argv: ["taskkill", "/?", "openclaw"],
    },
    {
      command: "openclaw gateway status",
      argv: ["openclaw", "gateway", "status"],
    },
    {
      command: "openclaw gateway --help",
      argv: ["openclaw", "gateway", "--help"],
    },
    {
      command: "openclaw gateway run --help",
      argv: ["openclaw", "gateway", "run", "--help"],
    },
    {
      command: 'sh -c "openclaw gateway run --help"',
      argv: ["sh", "-c", "openclaw gateway run --help"],
    },
    {
      command: "f() { openclaw update --yes; }",
      argv: ["f()", "{", "openclaw", "update", "--yes", "}"],
    },
    {
      command: "f() { g; }; g() { f; }; f",
      argv: ["f()", "{", "g"],
    },
    {
      command: "openclaw gateway call health",
      argv: ["openclaw", "gateway", "call", "health"],
    },
    {
      command: "openclaw gateway call update.status",
      argv: ["openclaw", "gateway", "call", "update.status"],
    },
    {
      command: "openclaw gateway call --json logs.tail --params '{}'",
      argv: ["openclaw", "gateway", "call", "--json", "logs.tail", "--params", "{}"],
    },
    {
      command: 'schtasks /Query /TN "OpenClaw Gateway"',
      argv: ["schtasks", "/Query", "/TN", "OpenClaw Gateway"],
    },
    {
      command: 'cmd.exe /d /s /c "schtasks /Query /TN \\"OpenClaw Gateway\\""',
      argv: ["cmd.exe", "/d", "/s", "/c", 'schtasks /Query /TN "OpenClaw Gateway"'],
    },
    {
      command: 'cmd.exe /d /s /c "echo openclaw gateway restart"',
      argv: ["cmd.exe", "/d", "/s", "/c", "echo openclaw gateway restart"],
    },
    {
      command: 'cmd.exe /d /s /c "rem openclaw gateway restart"',
      argv: ["cmd.exe", "/d", "/s", "/c", "rem openclaw gateway restart"],
    },
    {
      command: 'cmd.exe /d /s /c ":: openclaw gateway restart"',
      argv: ["cmd.exe", "/d", "/s", "/c", ":: openclaw gateway restart"],
    },
    {
      command: 'powershell.exe -NoProfile -Command "openclaw gateway status"',
      argv: ["powershell.exe", "-NoProfile", "-Command", "openclaw gateway status"],
    },
    {
      command: "timeout 5s openclaw gateway status",
      argv: ["timeout", "5s", "openclaw", "gateway", "status"],
    },
    {
      command: "taskset --cpu-list=0 openclaw gateway restart",
      argv: ["taskset", "--cpu-list=0", "openclaw", "gateway", "restart"],
    },
    {
      command: "nice -n 5 systemctl --user status openclaw-gateway.service",
      argv: ["nice", "-n", "5", "systemctl", "--user", "status", "openclaw-gateway.service"],
    },
    {
      command: 'nice -n 5 echo "openclaw gateway restart"',
      argv: ["nice", "-n", "5", "echo", "openclaw gateway restart"],
    },
    {
      command: 'strace echo "openclaw gateway restart"',
      argv: ["strace", "echo", "openclaw gateway restart"],
    },
    {
      command: 'strace -o trace.log echo "openclaw gateway restart"',
      argv: ["strace", "-o", "trace.log", "echo", "openclaw gateway restart"],
    },
    {
      command: 'watch -n 5 echo "openclaw gateway restart"',
      argv: ["watch", "-n", "5", "echo", "openclaw gateway restart"],
    },
    {
      command: "command -v openclaw gateway restart",
      argv: ["command", "-v", "openclaw", "gateway", "restart"],
    },
    {
      command: "sudo -l openclaw gateway restart",
      argv: ["sudo", "-l", "openclaw", "gateway", "restart"],
    },
    {
      command: "watch --help openclaw gateway restart",
      argv: ["watch", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: "launchctl asuser 501 echo 'openclaw gateway restart'",
      argv: ["launchctl", "asuser", "501", "echo", "openclaw gateway restart"],
    },
    {
      command: 'nohup echo "openclaw gateway restart"',
      argv: ["nohup", "echo", "openclaw gateway restart"],
    },
    {
      command: "setsid openclaw gateway status",
      argv: ["setsid", "openclaw", "gateway", "status"],
    },
    {
      command: 'setsid echo "openclaw gateway restart"',
      argv: ["setsid", "echo", "openclaw gateway restart"],
    },
    {
      command: "taskset 0x1 openclaw gateway status",
      argv: ["taskset", "0x1", "openclaw", "gateway", "status"],
    },
    {
      command: "ionice -p 1234 openclaw gateway restart",
      argv: ["ionice", "-p", "1234", "openclaw", "gateway", "restart"],
    },
    {
      command: 'chrt -o echo "openclaw gateway restart"',
      argv: ["chrt", "-o", "echo", "openclaw gateway restart"],
    },
    {
      command: "flock /tmp/oc.lock echo -c 'systemctl --user restart openclaw-gateway.service'",
      argv: [
        "flock",
        "/tmp/oc.lock",
        "echo",
        "-c",
        "systemctl --user restart openclaw-gateway.service",
      ],
    },
    {
      command: "/usr/bin/time --help openclaw gateway restart",
      argv: ["/usr/bin/time", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: "timeout --help openclaw gateway restart",
      argv: ["timeout", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: "nice --help openclaw gateway restart",
      argv: ["nice", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: "flock --help openclaw gateway restart",
      argv: ["flock", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: "nohup --help openclaw gateway restart",
      argv: ["nohup", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: "env --help openclaw gateway restart",
      argv: ["env", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: "env --default-signal --help openclaw gateway restart",
      argv: ["env", "--default-signal", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: 'env -S "--help openclaw gateway restart"',
      argv: ["env", "-S", "--help openclaw gateway restart"],
    },
    {
      command: `${"env ".repeat(32)}echo "openclaw gateway restart"`,
      argv: [...Array(32).fill("env"), "echo", "openclaw gateway restart"],
    },
    {
      command: "env -S 'echo openclaw ${OC_AREA} ${OC_ACTION}'",
      argv: ["env", "-S", "echo openclaw ${OC_AREA} ${OC_ACTION}"],
    },
    {
      command: "env -S 'openclaw config get ${KEY}'",
      argv: ["env", "-S", "openclaw config get ${KEY}"],
    },
    {
      command: "env -S 'systemctl --user status ${UNIT}'",
      argv: ["env", "-S", "systemctl --user status ${UNIT}"],
    },
    {
      command: "env -S 'systemctl ${ACTION} nginx.service'",
      argv: ["env", "-S", "systemctl ${ACTION} nginx.service"],
    },
    {
      command: "env FOO=bar -u BAZ openclaw gateway restart",
      argv: ["env", "FOO=bar", "-u", "BAZ", "openclaw", "gateway", "restart"],
    },
    {
      command: "env -S '\"\" openclaw gateway restart'",
      argv: ["env", "-S", '"" openclaw gateway restart'],
    },
    {
      command: String.raw`env -S "echo '\c' openclaw gateway restart"`,
      argv: ["env", "-S", String.raw`echo '\c' openclaw gateway restart`],
    },
    {
      command: String.raw`env -S "openclaw\ngateway\trestart"`,
      argv: ["env", "-S", String.raw`openclaw\ngateway\trestart`],
    },
    {
      command: "env -S 'openclaw gateway restart $BAD'",
      argv: ["env", "-S", "openclaw gateway restart $BAD"],
    },
    {
      command: 'env -S "${OC_BIN:-echo} gateway restart"',
      argv: ["env", "-S", "${OC_BIN:-echo} gateway restart"],
    },
    {
      command: "env --help -S 'openclaw ${OC_AREA} ${OC_ACTION}'",
      argv: ["env", "--help", "-S", "openclaw ${OC_AREA} ${OC_ACTION}"],
    },
    {
      command: "echo env -S 'openclaw ${OC_AREA} ${OC_ACTION}'",
      argv: ["echo", "env", "-S", "openclaw ${OC_AREA} ${OC_ACTION}"],
    },
    {
      command: "node -e 'console.log(process.argv)' openclaw gateway restart",
      argv: ["node", "-e", "console.log(process.argv)", "openclaw", "gateway", "restart"],
    },
    {
      command: "node --print 'process.argv' openclaw gateway restart",
      argv: ["node", "--print", "process.argv", "openclaw", "gateway", "restart"],
    },
    {
      command: 'echo "kill -TERM $(pidof openclaw)"',
      argv: ["echo", "kill -TERM $(pidof openclaw)"],
    },
    {
      command: "echo 'pgrep -f openclaw | xargs kill'",
      argv: ["echo", "pgrep -f openclaw | xargs kill"],
    },
    {
      command: "sh -c \"echo 'pgrep -f openclaw | xargs kill'\"",
      argv: ["sh", "-c", "echo 'pgrep -f openclaw | xargs kill'"],
    },
    {
      command: "sh -c \"git grep 'openclaw gateway restart'\"",
      argv: ["sh", "-c", "git grep 'openclaw gateway restart'"],
    },
    {
      command: "sh -c \"logger 'openclaw gateway restart'\"",
      argv: ["sh", "-c", "logger 'openclaw gateway restart'"],
    },
    {
      command: "strace -b execve echo openclaw gateway restart",
      argv: ["strace", "-b", "execve", "echo", "openclaw", "gateway", "restart"],
    },
    {
      command: 'echo "openclaw gateway restart"',
      argv: ["echo", "openclaw gateway restart"],
    },
    {
      command: "openclaw gateway restart --help",
      argv: ["openclaw", "gateway", "restart", "--help"],
    },
    {
      command: "openclaw daemon stop --help",
      argv: ["openclaw", "daemon", "stop", "--help"],
    },
    {
      command: "openclaw onboard --no-install-daemon",
      argv: ["openclaw", "onboard", "--no-install-daemon"],
    },
    {
      command: "openclaw onboard --install-daemon --help",
      argv: ["openclaw", "onboard", "--install-daemon", "--help"],
    },
    {
      command: "echo '$(openclaw gateway restart)'",
      argv: ["echo", "$(openclaw gateway restart)"],
    },
    {
      command: String.raw`echo "\$(openclaw gateway restart)"`,
      argv: ["echo", "$(openclaw gateway restart)"],
    },
    {
      command: `echo "$(printf '%s' 'openclaw gateway restart')"`,
      argv: ["echo", "$(printf '%s' 'openclaw gateway restart')"],
    },
    {
      command: 'printf "%s\\n" "openclaw gateway restart"',
      argv: ["printf", "%s\\n", "openclaw gateway restart"],
    },
    {
      command: String.raw`sh -c 'echo openclaw\_gateway\_restart'`,
      argv: ["sh", "-c", String.raw`echo openclaw\_gateway\_restart`],
    },
    {
      command: "xargs --help openclaw gateway restart",
      argv: ["xargs", "--help", "openclaw", "gateway", "restart"],
    },
    {
      command: "xargs --max-args openclaw gateway restart",
      argv: ["xargs", "--max-args", "openclaw", "gateway", "restart"],
    },
    {
      command: "printf openclaw | xargs -I{} echo {} gateway restart",
      argv: ["xargs", "-I{}", "echo", "{}", "gateway", "restart"],
    },
    {
      command: "printf 'openclaw gateway restart\\n' | xargs echo",
      argv: ["xargs", "echo"],
    },
    {
      command: "printf 'nginx\\n' | xargs -r pkill",
      argv: ["printf", "nginx\\n"],
    },
    {
      command: "printf ignored | xargs sh -c 'echo OpenClaw'",
      argv: ["xargs", "sh", "-c", "echo OpenClaw"],
    },
    {
      command: "printf Restart-Service >/dev/null; echo openclaw",
      argv: ["printf", "Restart-Service"],
    },
    {
      command: `$cmd='Write-Output'; & $cmd OpenClaw`,
      argv: ["$cmd=Write-Output"],
    },
    {
      command: "find . -name openclaw gateway restart",
      argv: ["find", ".", "-name", "openclaw", "gateway", "restart"],
    },
    {
      command: "npx @openclaw/plugin-sdk gateway restart",
      argv: ["npx", "@openclaw/plugin-sdk", "gateway", "restart"],
    },
    {
      command: "pnpm exec echo openclaw gateway restart",
      argv: ["pnpm", "exec", "echo", "openclaw", "gateway", "restart"],
    },
    {
      command: "npx echo openclaw gateway restart",
      argv: ["npx", "echo", "openclaw", "gateway", "restart"],
    },
    {
      command: "npx -y echo openclaw gateway restart",
      argv: ["npx", "-y", "echo", "openclaw", "gateway", "restart"],
    },
    {
      command: "git grep 'openclaw gateway restart'",
      argv: ["git", "grep", "openclaw gateway restart"],
    },
    {
      command: "logger 'openclaw gateway restart'",
      argv: ["logger", "openclaw gateway restart"],
    },
    {
      command: "killall --user openclaw nginx",
      argv: ["killall", "--user", "openclaw", "nginx"],
    },
    {
      command: "service openclaw-gateway status",
      argv: ["service", "openclaw-gateway", "status"],
    },
    {
      command: "Get-Service OpenClaw",
      argv: ["Get-Service", "OpenClaw"],
    },
    {
      command: "Restart-Service OpenClaw -WhatIf",
      argv: ["Restart-Service", "OpenClaw", "-WhatIf"],
    },
    {
      command: "Restart-Service OpenClaw -Wh",
      argv: ["Restart-Service", "OpenClaw", "-Wh"],
    },
    {
      command: "Stop-Process -Name OpenClaw -WhatIf:$true",
      argv: ["Stop-Process", "-Name", "OpenClaw", "-WhatIf:$true"],
    },
    {
      command: "Get-Service OpenClaw | Restart-Service -WhatIf",
      argv: ["Get-Service", "OpenClaw"],
    },
    {
      command: "Get-Process nginx | Stop-Process",
      argv: ["Get-Process", "nginx"],
    },
    {
      command: "gps nginx | kill",
      argv: ["gps", "nginx"],
    },
    {
      command: "Stop-Process -Name:nginx",
      argv: ["Stop-Process", "-Name:nginx"],
    },
    {
      command: "ps ax -o pid=,command= | awk '/nginx/{print $1}' | xargs -r kill",
      argv: ["ps", "ax", "-o", "pid=,command="],
    },
    {
      command: "Get-Process -Id OpenClaw | Stop-Process",
      argv: ["Get-Process", "-Id", "OpenClaw"],
    },
    {
      command: "Get-Service OpenClaw | Get-Service",
      argv: ["Get-Service", "OpenClaw"],
    },
    {
      command: "Get-Service OpenClaw | ForEach-Object { Write-Output $_ }",
      argv: ["Get-Service", "OpenClaw"],
    },
    {
      command: "Get-Service OpenClaw | % { Restart-Service nginx }",
      argv: ["Get-Service", "OpenClaw"],
    },
    {
      command: 'powershell -Command "Write-Output ok # Restart-Service OpenClaw"',
      argv: ["powershell", "-Command", "Write-Output ok # Restart-Service OpenClaw"],
    },
    {
      command: 'powershell -Command "Write-Output ok # $(openclaw update --yes)"',
      argv: ["powershell", "-Command", "Write-Output ok # $(openclaw update --yes)"],
    },
    {
      command: 'cmd.exe /d /s /c "rem $(openclaw gateway restart)"',
      argv: ["cmd.exe", "/d", "/s", "/c", "rem $(openclaw gateway restart)"],
    },
    {
      command: "launchctl submit -l test -- /usr/bin/sleep 60",
      argv: ["launchctl", "submit", "-l", "test", "--", "/usr/bin/sleep", "60"],
    },
    {
      command: "systemctl isolate rescue.target",
      argv: ["systemctl", "isolate", "rescue.target"],
    },
    {
      command: "Set-Service -Description OpenClaw -Name nginx",
      argv: ["Set-Service", "-Description", "OpenClaw", "-Name", "nginx"],
    },
    {
      command: "sasv nginx",
      argv: ["sasv", "nginx"],
    },
    {
      command: "sh -c 'true # openclaw gateway restart'",
      argv: ["sh", "-c", "true # openclaw gateway restart"],
    },
    {
      command: 'schtasks /Create /TN benign /TR "cmd /c echo openclaw"',
      argv: ["schtasks", "/Create", "/TN", "benign", "/TR", "cmd /c echo openclaw"],
    },
    {
      command: "if echo openclaw update --yes; then :; fi",
      argv: ["if", "echo", "openclaw", "update", "--yes"],
    },
    {
      command: "if echo openclaw gateway restart; then :; fi",
      argv: ["if", "echo", "openclaw", "gateway", "restart"],
    },
    {
      command: "case x in x) echo openclaw update --yes;; esac",
      argv: ["case", "x", "in", "x)", "echo", "openclaw", "update", "--yes"],
    },
    {
      command: "sc.exe query OpenClaw",
      argv: ["sc.exe", "query", "OpenClaw"],
    },
    {
      command: "net start",
      argv: ["net", "start"],
    },
    {
      command: "npm exec echo -- openclaw gateway restart",
      argv: ["npm", "exec", "echo", "--", "openclaw", "gateway", "restart"],
    },
  ])(
    "does not require lifecycle approval for read-only or generic command %j",
    ({ command, argv }) => {
      expect(
        commandRequiresOpenClawLifecycleApproval({
          command,
          segments: [{ raw: command, argv }],
        }),
      ).toBe(false);
    },
  );

  it("does not fall back to lifecycle text inside a parsed shell comment", () => {
    const command = ": # openclaw gateway restart";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [{ raw: ":", argv: [":"] }],
      }),
    ).toBe(false);
  });
});
