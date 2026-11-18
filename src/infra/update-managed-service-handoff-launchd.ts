import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
} from "../daemon/launchd-exec.js";
import { resolveLaunchAgentGuiDomain } from "../daemon/launchd-runtime.js";
import { escapeXml } from "../shared/xml.js";

/** A one-shot sibling job, not a persistent LaunchAgent or a child of the job being replaced. */
export async function prepareLaunchdUpdateHandoff(params: {
  directory: string;
  env: NodeJS.ProcessEnv;
  executable: string;
  args: string[];
}) {
  const label = `ai.openclaw.update.${randomUUID()}`;
  const domain = resolveLaunchAgentGuiDomain();
  const target = `${domain}/${label}`;
  const socket = path.join(params.directory, "ctl");
  const plist = path.join(params.directory, "handoff.plist");
  const environment = path.join(params.directory, "launchd-env.json");
  // Do not advertise Gateway credentials in launchctl print or in process arguments.
  // Run one foreground job for the entire helper lifetime. Wait=true gives it the
  // *listening* descriptor on stdin, not a short-lived per-connection launch proxy.
  const execPrepared = `
const fs = require("node:fs");
const { createServer } = require("node:net");
const { spawn } = require("node:child_process");
const [file, ...args] = process.argv.slice(1);
const env = JSON.parse(fs.readFileSync(file, "utf8"));
fs.unlinkSync(file);
const server = createServer({ pauseOnConnect: true });
server.once("connection", socket => {
  server.close();
  const child = spawn(process.execPath, args, { env, stdio: [socket, socket, 2] });
  socket.destroy();
  child.once("error", error => { console.error(error); process.exitCode = 1; });
});
server.listen({ fd: 0 });`;
  const argv = [
    "/bin/sh",
    "-c",
    'target=$1; shift; "$@"; /bin/launchctl bootout "$target" || { status=$?; printf "launchctl bootout %s failed (exit %s)\\n" "$target" "$status" >&2; exit "$status"; }',
    "openclaw-update",
    target,
    params.executable,
    "-e",
    execPrepared,
    "--",
    environment,
    ...params.args,
  ];
  // The caller keeps its readiness, transfer, cancellation and lease protocol.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>WorkingDirectory</key><string>${escapeXml(params.directory)}</string>
<key>ProgramArguments</key><array>${argv.map((arg) => `<string>${escapeXml(arg)}</string>`).join("")}</array>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>${escapeXml(path.join(params.directory, "handoff.log"))}</string>
<key>inetdCompatibility</key><dict><key>Wait</key><true/></dict>
<key>Sockets</key><dict><key>Control</key><dict><key>SockPathName</key><string>${escapeXml(socket)}</string><key>SockPathMode</key><integer>384</integer></dict></dict>
</dict></plist>`;
  await fs.writeFile(environment, JSON.stringify(params.env), { mode: 0o600, flag: "wx" });
  // launchd expects a readable plist even when the serving job uses umask 077.
  // Its containing mkdtemp directory is private; the plist contains no env values.
  await fs.writeFile(plist, xml, { mode: 0o644, flag: "wx" });
  await fs.chmod(plist, 0o644);
  let attempted = false;
  return {
    command: "/usr/bin/nc",
    args: ["-U", socket],
    files: [plist, environment, socket],
    async bootstrap() {
      attempted = true;
      const result = await execLaunchctl(["bootstrap", domain, plist], 10_000);
      if (result.code !== 0) {
        throw new Error(
          `launchctl bootstrap of update helper failed: ${formatLaunchctlResultDetail(result)}`,
        );
      }
    },
    // Before transfer the caller owns cleanup. Afterwards the job retires itself,
    // even when replacing the Gateway has already closed the control connection.
    async bootout() {
      if (attempted) {
        try {
          const result = await execLaunchctl(["bootout", target], 10_000);
          if (result.code !== 0 && !isLaunchctlNotLoaded(result)) {
            throw new Error(formatLaunchctlResultDetail(result) || `exit ${result.code}`);
          }
        } catch (cause) {
          throw new Error(`launchctl bootout ${target} failed: ${String(cause)}`, { cause });
        }
      }
    },
  };
}
