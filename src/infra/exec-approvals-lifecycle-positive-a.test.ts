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
      command: "launchctl stop gui/$UID/com.openclaw.gateway",
      argv: ["launchctl", "stop", "gui/$UID/com.openclaw.gateway"],
    },
    {
      command: "launchctl kickstart -k gui/$UID/com.openclaw.gateway",
      argv: ["launchctl", "kickstart", "-k", "gui/$UID/com.openclaw.gateway"],
    },
    {
      command: "launchctl debug gui/$UID/com.openclaw.gateway --program /tmp/replacement",
      argv: [
        "launchctl",
        "debug",
        "gui/$UID/com.openclaw.gateway",
        "--program",
        "/tmp/replacement",
      ],
    },
    {
      command: "launchctl attach -x gui/$UID/com.openclaw.gateway",
      argv: ["launchctl", "attach", "-x", "gui/$UID/com.openclaw.gateway"],
    },
    {
      command: "launchctl start com.openclaw.gateway",
      argv: ["launchctl", "start", "com.openclaw.gateway"],
    },
    {
      command: "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.openclaw.gateway.plist",
      argv: [
        "launchctl",
        "bootstrap",
        "gui/$UID",
        "~/Library/LaunchAgents/com.openclaw.gateway.plist",
      ],
    },
    {
      command: "launchctl asuser 501 openclaw gateway restart",
      argv: ["launchctl", "asuser", "501", "openclaw", "gateway", "restart"],
    },
    {
      command: "launchctl bsexec 123 openclaw gateway restart",
      argv: ["launchctl", "bsexec", "123", "openclaw", "gateway", "restart"],
    },
    {
      command: "launchctl submit -l test -- openclaw gateway restart",
      argv: ["launchctl", "submit", "-l", "test", "--", "openclaw", "gateway", "restart"],
    },
    {
      command: "launchctl submit -l com.openclaw.gateway -- /usr/bin/sleep 60",
      argv: ["launchctl", "submit", "-l", "com.openclaw.gateway", "--", "/usr/bin/sleep", "60"],
    },
    {
      command: "systemctl --user restart openclaw-gateway.service",
      argv: ["systemctl", "--user", "restart", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --user start openclaw-gateway.service",
      argv: ["systemctl", "--user", "start", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --user reenable openclaw-gateway.service",
      argv: ["systemctl", "--user", "reenable", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --user preset openclaw-gateway.service",
      argv: ["systemctl", "--user", "preset", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --user reload openclaw-gateway.service",
      argv: ["systemctl", "--user", "reload", "openclaw-gateway.service"],
    },
    {
      command: "systemctl bind openclaw-gateway.service /host/path:/run/path",
      argv: ["systemctl", "bind", "openclaw-gateway.service", "/host/path:/run/path"],
    },
    {
      command: "systemctl isolate openclaw.target",
      argv: ["systemctl", "isolate", "openclaw.target"],
    },
    {
      command: "systemctl --user restart 'opencl[a]w-gateway.service'",
      argv: ["systemctl", "--user", "restart", "opencl[a]w-gateway.service"],
    },
    {
      command: `systemctl restart "$(printf 'open%s-gateway.service' claw)"`,
      argv: ["systemctl", "restart", "$(printf open%s-gateway.service claw)"],
    },
    {
      command: "bash -c 'systemctl restart open{claw,-other}-gateway.service'",
      argv: ["bash", "-c", "systemctl restart open{claw,-other}-gateway.service"],
    },
    {
      command: "systemctl -qM .host restart 'opencl[a]w-gateway.service'",
      argv: ["systemctl", "-qM", ".host", "restart", "opencl[a]w-gateway.service"],
    },
    {
      command: "systemctl --image-policy ignore restart openclaw-gateway.service",
      argv: ["systemctl", "--image-policy", "ignore", "restart", "openclaw-gateway.service"],
    },
    {
      command: "service openclaw-gateway restart",
      argv: ["service", "openclaw-gateway", "restart"],
    },
    {
      command: "service openclaw-gateway try-restart",
      argv: ["service", "openclaw-gateway", "try-restart"],
    },
    {
      command: "sudo service openclaw-gateway stop",
      argv: ["sudo", "service", "openclaw-gateway", "stop"],
    },
    {
      command: "watch openclaw gateway restart",
      argv: ["watch", "openclaw", "gateway", "restart"],
    },
    {
      command: "watch -n 5 openclaw gateway restart",
      argv: ["watch", "-n", "5", "openclaw", "gateway", "restart"],
    },
    {
      command: "strace openclaw gateway restart",
      argv: ["strace", "openclaw", "gateway", "restart"],
    },
    {
      command: "openclaw onboard --install-daemon",
      argv: ["openclaw", "onboard", "--install-daemon"],
    },
    {
      command: "openclaw setup --install-daemon",
      argv: ["openclaw", "setup", "--install-daemon"],
    },
    {
      command: "sh -c \"git grep 'openclaw gateway restart'; openclaw gateway restart\"",
      argv: ["sh", "-c", "git grep 'openclaw gateway restart'; openclaw gateway restart"],
    },
    {
      command: "strace -E FOO=bar openclaw gateway restart",
      argv: ["strace", "-E", "FOO=bar", "openclaw", "gateway", "restart"],
    },
    {
      command: "strace --env FOO=bar openclaw gateway restart",
      argv: ["strace", "--env", "FOO=bar", "openclaw", "gateway", "restart"],
    },
    {
      command: "strace -b execve openclaw gateway restart",
      argv: ["strace", "-b", "execve", "openclaw", "gateway", "restart"],
    },
    {
      command: 'echo "$(openclaw gateway restart)"',
      argv: ["echo", "$(openclaw gateway restart)"],
    },
    {
      command: "printf '%s' `systemctl --user restart openclaw-gateway.service`",
      argv: ["printf", "%s", "systemctl --user restart openclaw-gateway.service"],
    },
    {
      command: "Restart-Service OpenClaw",
      argv: ["Restart-Service", "OpenClaw"],
    },
    {
      command: "Restart-Service Open`Claw",
      argv: ["Restart-Service", "Open`Claw"],
    },
    {
      command: "Set-Service -Status Stopped -Name OpenClaw",
      argv: ["Set-Service", "-Status", "Stopped", "-Name", "OpenClaw"],
    },
    {
      command: "Stop-Process -Name:OpenCla?",
      argv: ["Stop-Process", "-Name:OpenCla?"],
    },
    {
      command: "spps -Name:OpenCla?",
      argv: ["spps", "-Name:OpenCla?"],
    },
    {
      command: "Restart-Service -Name 'OpenCla?'",
      argv: ["Restart-Service", "-Name", "OpenCla?"],
    },
    {
      command: "Restart-Service -ServiceName:OpenClaw",
      argv: ["Restart-Service", "-ServiceName:OpenClaw"],
    },
    {
      command: "Restart-Service OpenClaw -WhatIf:$false",
      argv: ["Restart-Service", "OpenClaw", "-WhatIf:$false"],
    },
    {
      command: "Restart-Service ('Open'+'Claw')",
      argv: ["Restart-Service", "(Open+Claw)"],
    },
    {
      command: "Stop-Process -Name ('Open'+'Claw')",
      argv: ["Stop-Process", "-Name", "(Open+Claw)"],
    },
    {
      command: "Get-Process OpenClaw | Stop-Process",
      argv: ["Get-Process", "OpenClaw"],
    },
    {
      command: "$(Get-Process OpenClaw) | Stop-Process",
      argv: ["$(Get-Process", "OpenClaw)"],
    },
    {
      command: "(Get-Service OpenClaw) | Restart-Service",
      argv: ["(Get-Service", "OpenClaw)"],
    },
    {
      command: "Get-Process OpenClaw | kill",
      argv: ["Get-Process", "OpenClaw"],
    },
    {
      command: "Get-Process OpenClaw | spps",
      argv: ["Get-Process", "OpenClaw"],
    },
    {
      command: "Get-Service -Name 'OpenCla?' | Restart-Service",
      argv: ["Get-Service", "-Name", "OpenCla?"],
    },
    {
      command: "Get-Service -Na:OpenClaw | Restart-Service",
      argv: ["Get-Service", "-Na:OpenClaw"],
    },
    {
      command: "Get-Process -Na:OpenClaw | Stop-Process",
      argv: ["Get-Process", "-Na:OpenClaw"],
    },
    {
      command: "Get-Service OpenClaw | ForEach-Object { Restart-Service $_ }",
      argv: ["Get-Service", "OpenClaw"],
    },
    {
      command: "Get-Service OpenClaw | ForEach-Object { $_ | Restart-Service }",
      argv: ["Get-Service", "OpenClaw"],
    },
    {
      command: "Get-Process OpenClaw | % { Stop-Process -Id $_.Id }",
      argv: ["Get-Process", "OpenClaw"],
    },
    {
      command: "Get-Service | Where-Object Name -Like 'OpenClaw*' | Restart-Service",
      argv: ["Get-Service"],
    },
    {
      command: "Get-Service | Where-Object Name -Like Open`Claw* | Restart-Service",
      argv: ["Get-Service"],
    },
    {
      command: "Get-Service | Where-Object Name -Like ('Open'+'Claw*') | Restart-Service",
      argv: ["Get-Service"],
    },
    {
      command: "Restart-Service OpenClaw -WhatIf $(openclaw update --yes)",
      argv: ["Restart-Service", "OpenClaw", "-WhatIf", "$(openclaw update --yes)"],
    },
    {
      command: `$v='Restart'; $n='Service'; $cmd="$v-$n"; & $cmd OpenClaw`,
      argv: ["$v=Restart"],
    },
    {
      command: "openclaw gateway call --token help update.run",
      argv: ["openclaw", "gateway", "call", "--token", "help", "update.run"],
    },
    {
      command: "gps OpenClaw | kill",
      argv: ["gps", "OpenClaw"],
    },
    {
      command: "ps OpenClaw | spps",
      argv: ["ps", "OpenClaw"],
    },
    {
      command: "gsv -Name 'OpenCla?' | Restart-Service",
      argv: ["gsv", "-Name", "OpenCla?"],
    },
    {
      command: "sc.exe stop OpenClaw",
      argv: ["sc.exe", "stop", "OpenClaw"],
    },
    {
      command: "sc.exe delete OpenClaw",
      argv: ["sc.exe", "delete", "OpenClaw"],
    },
    {
      command: "sc.exe sdset OpenClaw D:(A;;CC;;;SY)",
      argv: ["sc.exe", "sdset", "OpenClaw", "D:(A;;CC;;;SY)"],
    },
    {
      command: "sc.exe description OpenClaw managed-by-openclaw",
      argv: ["sc.exe", "description", "OpenClaw", "managed-by-openclaw"],
    },
    {
      command: 'sc.exe \\\\gateway-host stop "OpenClaw Gateway"',
      argv: ["sc.exe", "\\\\gateway-host", "stop", "OpenClaw Gateway"],
    },
    {
      command: 'net stop "OpenClaw Gateway"',
      argv: ["net", "stop", "OpenClaw Gateway"],
    },
    {
      command: 'powershell -NoProfile -Command "Restart-Service OpenClaw"',
      argv: ["powershell", "-NoProfile", "-Command", "Restart-Service OpenClaw"],
    },
    {
      command: `powershell -NoProfile -Command "& ('open'+'claw') gateway restart"`,
      argv: ["powershell", "-NoProfile", "-Command", "& ('open'+'claw') gateway restart"],
    },
    {
      command: 'powershell -NoProfile -Command "Restart-Service -Na:Open`Claw"',
      argv: ["powershell", "-NoProfile", "-Command", "Restart-Service -Na:Open`Claw"],
    },
    {
      command: 'powershell -NoProfile -Command "Get-Process OpenClaw | Stop-Process"',
      argv: ["powershell", "-NoProfile", "-Command", "Get-Process OpenClaw | Stop-Process"],
    },
    {
      command: "systemctl --user try-reload-or-restart openclaw-gateway.service",
      argv: ["systemctl", "--user", "try-reload-or-restart", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --user condrestart openclaw-gateway.service",
      argv: ["systemctl", "--user", "condrestart", "openclaw-gateway.service"],
    },
    {
      command: "systemctl -s TERM kill openclaw-gateway.service",
      argv: ["systemctl", "-s", "TERM", "kill", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --signal=TERM kill openclaw-gateway.service",
      argv: ["systemctl", "--signal=TERM", "kill", "openclaw-gateway.service"],
    },
    {
      command: "systemctl set-property openclaw-gateway.service MemoryMax=1",
      argv: ["systemctl", "set-property", "openclaw-gateway.service", "MemoryMax=1"],
    },
    {
      command: "systemctl clean openclaw-gateway.service",
      argv: ["systemctl", "clean", "openclaw-gateway.service"],
    },
    {
      command: "systemctl --user reset-failed openclaw-gateway.service",
      argv: ["systemctl", "--user", "reset-failed", "openclaw-gateway.service"],
    },
    {
      command: "systemctl revert openclaw-gateway.service",
      argv: ["systemctl", "revert", "openclaw-gateway.service"],
    },
    {
      command: "systemctl link /tmp/openclaw-gateway.service",
      argv: ["systemctl", "link", "/tmp/openclaw-gateway.service"],
    },
    {
      command: "systemctl --signal=0 --signal=TERM kill openclaw-gateway.service",
      argv: ["systemctl", "--signal=0", "--signal=TERM", "kill", "openclaw-gateway.service"],
    },
    {
      command: "kill -TERM $(pidof openclaw)",
      argv: ["kill", "-TERM", "$(pidof", "openclaw)"],
    },
    {
      command: "kill -- -0 $(pidof openclaw)",
      argv: ["kill", "--", "-0", "$(pidof", "openclaw)"],
    },
    {
      command: "kill -- --help $(pidof openclaw)",
      argv: ["kill", "--", "--help", "$(pidof", "openclaw)"],
    },
    {
      command: "systemctl kill -- -s0 openclaw-gateway.service",
      argv: ["systemctl", "kill", "--", "-s0", "openclaw-gateway.service"],
    },
    {
      command: "pidof openclaw | xargs kill",
      argv: ["pidof", "openclaw"],
    },
    {
      command: "pgrep -f openclaw | xargs -r kill -TERM",
      argv: ["pgrep", "-f", "openclaw"],
    },
    {
      command: "printf 'openclaw\\n' | xargs -r pkill",
      argv: ["printf", "openclaw\\n"],
    },
    {
      command: "printf Restart-Service >/dev/null; pgrep -f '[o]penclaw' | xargs -r kill -TERM",
      argv: ["printf", "Restart-Service"],
    },
    {
      command:
        "echo 'not a pipeline: pgrep -f openclaw | xargs kill'; pgrep -f openclaw | xargs kill",
      argv: ["echo", "not a pipeline: pgrep -f openclaw | xargs kill"],
    },
    {
      command: "pkill -f 'opencla[w]'",
      argv: ["pkill", "-f", "opencla[w]"],
    },
    {
      command: "pkill -s 0 openclaw",
      argv: ["pkill", "-s", "0", "openclaw"],
    },
    {
      command: "pkill -f '[o]penclaw'",
      argv: ["pkill", "-f", "[o]penclaw"],
    },
    {
      command: "pkill --signal 0 --signal TERM openclaw",
      argv: ["pkill", "--signal", "0", "--signal", "TERM", "openclaw"],
    },
    {
      command: "pkill -f /opt/openclaw/dist/index.js",
      argv: ["pkill", "-f", "/opt/openclaw/dist/index.js"],
    },
    {
      command: "pkill -f 'opencl[[:alpha:]]w'",
      argv: ["pkill", "-f", "opencl[[:alpha:]]w"],
    },
    {
      command: "spps -Name OpenClaw",
      argv: ["spps", "-Name", "OpenClaw"],
    },
    {
      command: "spps -Name 'OpenCla?'",
      argv: ["spps", "-Name", "OpenCla?"],
    },
    {
      command: "taskkill /IM openclaw.exe /F",
      argv: ["taskkill", "/IM", "openclaw.exe", "/F"],
    },
    {
      command: "pgrep -f '[o]penclaw' | xargs -r kill -TERM",
      argv: ["pgrep", "-f", "[o]penclaw"],
    },
    {
      command: "ps ax -o pid=,command= | awk '/[o]penclaw/{print $1}' | xargs -r kill",
      argv: ["ps", "ax", "-o", "pid=,command="],
    },
    {
      command: `kill -TERM "$(pgrep -f '[o]penclaw')"`,
      argv: ["kill", "-TERM", "$(pgrep -f '[o]penclaw')"],
    },
    {
      command: `kill -TERM "$(cat /run/openclaw.pid)"`,
      argv: ["kill", "-TERM", "$(cat /run/openclaw.pid)"],
    },
    {
      command: "kill -TERM $(pgrep -f '[o]penclaw')",
      argv: ["kill", "-TERM", "$(pgrep", "-f", "'[o]penclaw')"],
    },
    {
      command: "kill -TERM $(ps ax -o pid=,command= | awk '/[o]penclaw/{print $1}')",
      argv: ["kill", "-TERM", "$(ps", "ax", "-o", "pid=,command=", "|", "awk"],
    },
    {
      command: "openclaw gateway restart",
      argv: ["openclaw", "gateway", "restart"],
    },
    {
      command: "open\\\nclaw gateway restart",
      argv: ["openclaw", "gateway", "restart"],
    },
    {
      command: "openclaw.cmd gateway restart",
      argv: ["openclaw.cmd", "gateway", "restart"],
    },
    {
      command: "openclaw.ps1 daemon restart",
      argv: ["openclaw.ps1", "daemon", "restart"],
    },
    {
      command: "./openclaw.mjs gateway restart",
      argv: ["./openclaw.mjs", "gateway", "restart"],
    },
    {
      command: "node openclaw.mjs daemon restart",
      argv: ["node", "openclaw.mjs", "daemon", "restart"],
    },
    {
      command: "node -r ts-node/register openclaw.mjs gateway restart",
      argv: ["node", "-r", "ts-node/register", "openclaw.mjs", "gateway", "restart"],
    },
    {
      command: "openclaw gateway start",
      argv: ["openclaw", "gateway", "start"],
    },
    {
      command: "openclaw gateway",
      argv: ["openclaw", "gateway"],
    },
    {
      command: "openclaw gateway run",
      argv: ["openclaw", "gateway", "run"],
    },
    {
      command: "openclaw gateway --force",
      argv: ["openclaw", "gateway", "--force"],
    },
    {
      command: "openclaw gateway --force restart",
      argv: ["openclaw", "gateway", "--force", "restart"],
    },
    {
      command: "openclaw gateway --port 18789 restart",
      argv: ["openclaw", "gateway", "--port", "18789", "restart"],
    },
    {
      command: "openclaw gateway --port 18789",
      argv: ["openclaw", "gateway", "--port", "18789"],
    },
    {
      command: "openclaw gateway run --force",
      argv: ["openclaw", "gateway", "run", "--force"],
    },
    {
      command: "openclaw gateway call update.run --params '{}'",
      argv: ["openclaw", "gateway", "call", "update.run", "--params", "{}"],
    },
    {
      command: "openclaw gateway call gateway.restart.request",
      argv: ["openclaw", "gateway", "call", "gateway.restart.request"],
    },
    {
      command: "openclaw gateway call --url ws://127.0.0.1:18789 update.run",
      argv: ["openclaw", "gateway", "call", "--url", "ws://127.0.0.1:18789", "update.run"],
    },
    {
      command: "openclaw update --yes",
      argv: ["openclaw", "update", "--yes"],
    },
    {
      command: "openclaw --update",
      argv: ["openclaw", "--update"],
    },
    {
      command: "openclaw --profile work --update --yes",
      argv: ["openclaw", "--profile", "work", "--update", "--yes"],
    },
    {
      command: "openclaw update repair --json --timeout 19",
      argv: ["openclaw", "update", "repair", "--json", "--timeout", "19"],
    },
    {
      command: "openclaw update --dry-run repair",
      argv: ["openclaw", "update", "--dry-run", "repair"],
    },
    {
      command: "openclaw update finalize --no-restart",
      argv: ["openclaw", "update", "finalize", "--no-restart"],
    },
    {
      command: "openclaw --update --dry-run finalize",
      argv: ["openclaw", "--update", "--dry-run", "finalize"],
    },
    {
      command: "openclaw update wizard --timeout 13",
      argv: ["openclaw", "update", "wizard", "--timeout", "13"],
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
