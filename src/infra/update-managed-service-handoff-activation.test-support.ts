import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readProcessAncestry } from "@openclaw/proc-safe/identity";
import { WebSocketServer } from "ws";
import { registerUpdateFixtureModuleOverrides } from "../cli/update-cli/update-module-overrides.test-support.js";

export async function waitForFixtureFile(file: string) {
  const deadline = Date.now() + 15_000;
  while (
    !(await fs.access(file).then(
      () => true,
      () => false,
    ))
  ) {
    if (Date.now() >= deadline) {
      throw new Error(`Fixture did not acknowledge ${path.basename(file)}`);
    }
    await delay(25);
  }
}

// Only the Linux scratch manager is simulated. The installer owns the plist and
// the choice/order of actions; the test runner owns (and reaps) its two processes.
export async function fixtureLaunchctl(dir: string, label: string, args: string[]) {
  const [action, arg, file] = args;
  const domain = `gui/${process.getuid!()}`;
  const target = `${domain}/${label}`;
  const result = (stdout = "", code = 0, stderr = "") => ({
    stdout,
    code,
    stderr,
    termination: "exit",
  });
  if (action === "print" && arg === `system/${label}`) {
    return result("", 113, "Could not find service");
  }
  if (action === "print" && arg === target) {
    const pid = await fs.readFile(path.join(dir, "manager.pid"), "utf8").catch(() => null);
    return pid
      ? result(`${target} = {\n\tstate = running\n\tpid = ${pid}\n}`)
      : result("", 113, "Could not find service");
  }
  if (action === "enable" && arg === target) {
    return result();
  }
  if (
    (action === "bootout" && arg === target) ||
    (action === "bootstrap" &&
      arg === domain &&
      file === path.join(dir, "Library", "LaunchAgents", `${label}.plist`))
  ) {
    await fs.writeFile(path.join(dir, action), "", { flag: "wx" });
    await waitForFixtureFile(path.join(dir, `${action}.done`));
    return result();
  }
  throw new Error(`Unexpected fixture launchctl: ${args.join(" ")}`);
}

export async function fixtureReadCommand(dir: string, label: string) {
  const { resolveLaunchAgentProgramArguments } = await import("../daemon/launchd-plist.js");
  const programArguments: string[] = JSON.parse(
    await fs.readFile(path.join(dir, "manager.command"), "utf8"),
  );
  return resolveLaunchAgentProgramArguments(
    { ProgramArguments: programArguments },
    path.join(dir, "Library", "LaunchAgents", `${label}.plist`),
  );
}

// Membership in a modeled job is observable only for the two process trees this
// fixture launched. Unknown roots or unreadable processes cannot authorize rebind.
export function fixtureMembership(dir: string, other: number) {
  const roots = new Set(
    ["manager.pid", "helper.pid"].map((file) => Number(readFileSync(path.join(dir, file), "utf8"))),
  );
  const owner = (pid: number) =>
    readProcessAncestry(pid)?.chain.find((row) => roots.has(row.pid))?.pid;
  const caller = owner(process.pid),
    target = owner(other);
  return !caller || !target ? "unknown" : caller === target ? "inside" : "outside";
}

export function registerLinuxJobObservation(dir: string, membershipUrl: string) {
  if (process.platform !== "linux" || process.env.HOME !== dir) {
    throw new Error("Expected an isolated Linux job");
  }
  registerUpdateFixtureModuleOverrides(
    new Map([
      [
        membershipUrl,
        `import {fixtureMembership} from ${JSON.stringify(import.meta.url)};
    export const inspectServiceProcessMembershipSync = pid => fixtureMembership(${JSON.stringify(dir)},pid);`,
      ],
    ]),
  );
}

export function registerLinuxFixtureManager(dir: string, label: string) {
  if (
    process.platform !== "linux" ||
    process.env.HOME !== dir ||
    !label.startsWith("ai.openclaw.test.conversion.")
  ) {
    throw new Error("Expected a scratch Linux manager");
  }
  // Model the account lookup in the same isolated child as the simulated manager.
  // Keep the production guard: its canonical state must be <account>/.openclaw.
  const account = os.userInfo();
  mock.method(os, "userInfo", () => ({ ...account, homedir: dir }));
  const source = (file: string) => new URL(file, import.meta.url).href;
  registerLinuxJobObservation(dir, source("../daemon/service-process-membership.ts"));
  registerUpdateFixtureModuleOverrides(
    new Map([
      [
        source("../daemon/launchd-exec.ts"),
        `import {fixtureLaunchctl} from ${JSON.stringify(import.meta.url)};
      export const execLaunchctl = args => fixtureLaunchctl(${JSON.stringify(dir)}, ${JSON.stringify(label)}, args);`,
      ],
      [
        source("../daemon/service.ts"),
        `import {readLaunchAgentRuntime,isLaunchAgentLoaded} from ${JSON.stringify(source("../daemon/launchd-runtime.ts"))};
      import {fixtureReadCommand} from ${JSON.stringify(import.meta.url)};
      import fs from 'node:fs/promises';
      export const resolveGatewayService = () => ({isLoaded:isLaunchAgentLoaded,
        readRuntime:async (...args)=>({...await readLaunchAgentRuntime(...args),systemd:{managerUid:(await fs.stat(${JSON.stringify(dir)})).uid}}),
        readCommand:()=>fixtureReadCommand(${JSON.stringify(dir)}, ${JSON.stringify(label)})});`,
      ],
    ]),
  );
}

// Respond to the real restart verifier's read-only client from the process which
// actually owns the fixture listener; never inject a healthy snapshot or verdict.
export async function serveFixtureHealth(
  server: Server,
  version: string,
  buildId: string,
  token: string,
  onHealth: () => void,
) {
  const {
    buildMinimalGatewayHelloOkPayload,
    parseMinimalGatewayRequestFrame,
    sendMinimalGatewayConnectChallenge,
    sendMinimalGatewayResponse,
  } = await import("../gateway/minimal-gateway.test-helpers.js");
  new WebSocketServer({ server }).on("connection", (socket) => {
    sendMinimalGatewayConnectChallenge(socket);
    let authenticated = false;
    socket.on("message", (raw) => {
      const { id, method, params } = parseMinimalGatewayRequestFrame(raw);
      if (!id) {
        return;
      }
      if (method === "connect") {
        if (params?.auth?.token !== token) {
          socket.close(1008, "Unexpected fixture credential");
          return;
        }
        authenticated = true;
        const hello = buildMinimalGatewayHelloOkPayload({
          methods: ["health"],
          auth: { role: "operator", scopes: ["operator.read"] },
        });
        sendMinimalGatewayResponse(socket, id, {
          ...hello,
          server: { ...hello.server, version, buildId },
        });
      } else if (authenticated && method === "health") {
        onHealth();
        sendMinimalGatewayResponse(socket, id, { ok: true, channels: {} });
      } else {
        socket.close(1008, "Unexpected fixture RPC");
      }
    });
  });
}
