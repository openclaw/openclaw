import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { updateExecutorEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import * as launchctl from "../daemon/launchd-exec.js";
import { buildLaunchAgentPlist } from "../daemon/launchd-plist.js";
import { resolveGatewaySupervisorLogPaths } from "../daemon/restart-logs.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { GIT_RELEASE_TRIAL, gitReleaseSlot } from "./git-release-paths.js";
import { createGitReleaseDirs, publishGitRelease } from "./git-release.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { waitForFixtureFile } from "./update-managed-service-handoff-activation.test-support.js";
import {
  fixtureProgramArguments,
  probeFixtureSocketJob,
} from "./update-managed-service-handoff-launchd.test-support.js";

const loader = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const node = resolveTestNodeExecPath();
const domain = `gui/${process.getuid?.()}`;
// The production transport uses this absolute path. Some Linux images have
// no nc or ship a TCP-only variant; neither can exercise this fixture.
const ncHelp =
  process.platform === "linux"
    ? spawnSync("/usr/bin/nc", ["-h"], { encoding: "utf8", timeout: 2000 })
    : undefined;
const linuxSocketClient =
  ncHelp && !ncHelp.error && /(?:^|\s)-U(?:\s|,|$)/u.test(`${ncHelp.stdout}\n${ncHelp.stderr}`);
// A real GUI job is opt-in: the production updater must see the real account
// home. Never try to make a relocated HOME pass native service admission.
const native =
  process.platform === "darwin" &&
  process.env.OPENCLAW_TEST_LAUNCHD_DISPOSABLE_HOME === os.userInfo().homedir &&
  spawnSync("/bin/launchctl", ["print", domain], { stdio: "ignore", timeout: 5000 }).status === 0;
// Full build strings; not merely equal package versions or truncated commit IDs.
const before = "2026.11.4-caa595355fe6-2026-11-17T21-36-33.135Z";
const target = "2026.11.4-ec9a77fa3c04-2026-11-17T22-27-54.958Z";
const source = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
const start = (argv: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
async function stop(child?: ChildProcess) {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
}

it.runIf(process.platform === "linux")(
  "passes the generated listening socket to the prepared program (inetd fixture)",
  async () => {
    const dir = await fs.mkdtemp("/tmp/oc-wire-");
    try {
      expect(await probeFixtureSocketJob(dir, node)).toBe("socket-probe");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

// The handed-off updater runs the production activation and verification owners.
// Both listeners are small RPC/HTTP fixtures. Linux models only the service manager
// and its membership; only the eligible macOS branch exercises a real GUI job.
it.runIf(Boolean(linuxSocketClient) || native)(
  `converts a serving checkout and settles the successor's full build (${native ? "native launchd" : "launchd fixture"})`,
  async () => {
    const dir = await fs.realpath(await fs.mkdtemp("/tmp/oc-convert-"));
    const profile = `test-conversion-${randomUUID()}`;
    const label = native ? `ai.openclaw.${profile}` : `ai.openclaw.test.conversion.${randomUUID()}`;
    const home = native ? os.userInfo().homedir : dir;
    const env = {
      HOME: home,
      OPENCLAW_HOME: home,
      ...(native ? { OPENCLAW_PROFILE: profile } : {}),
      TMPDIR: dir,
      OPENCLAW_STATE_DIR: path.join(home, native ? `.openclaw-${profile}` : ".openclaw"),
      OPENCLAW_LAUNCHD_LABEL: label,
      PATH: native ? process.env.PATH : `${dir}:${process.env.PATH}`,
    };
    const prefix = path.join(dir, "git-install");
    const slot = gitReleaseSlot(prefix);
    const trial = path.join(prefix, "releases", GIT_RELEASE_TRIAL);
    const plist = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
    const portFile = path.join(dir, "port");
    const checkout = path.join(dir, "checkout");
    const command = (entry: string) => [node, entry, "gateway"];
    const successor = command(path.join(prefix, "openclaw-launcher.mjs"));
    let ownsState = false;
    let ownsPlist = false;
    const ownedSupervisorLogs: string[] = [];
    let registered = false;
    let service: ChildProcess | undefined;
    let helperJob: ChildProcess | undefined;
    const trigger = randomUUID();
    const probeToken = randomUUID();
    try {
      await fs.mkdir(env.OPENCLAW_STATE_DIR, { mode: 0o700 });
      ownsState = true;
      await fs.writeFile(
        path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
        JSON.stringify({ gateway: { auth: { mode: "token", token: probeToken } } }),
        { flag: "wx", mode: 0o600 },
      );
      // Each process reads its own immutable stamp. Only the target clears its own trial,
      // after listen; an already-healthy old process cannot satisfy either assertion.
      const next = (await createGitReleaseDirs(prefix)).releaseRoot;
      const releaseGate = path.join(dir, "allow-rebind");
      const updater = path.join(checkout, "updater.mjs");
      const handoffReceipt = path.join(dir, "handoff-receipt");
      const activationReceipt = path.join(dir, "activation.json");
      const support = source("./update-managed-service-handoff-activation.test-support.ts");
      const setup = `await import(${JSON.stringify(loader)});
        const fixture = await import(${support});
        ${native ? "" : `fixture.registerLinuxFixtureManager(${JSON.stringify(dir)}, ${JSON.stringify(label)});`}`;
      const updateSource = `import fs from 'node:fs/promises';
        ${setup}
        const {publishGitRelease} = await import(${source("./git-release.ts")});
        const publication = await publishGitRelease({prefix:${JSON.stringify(prefix)},releaseRoot:${JSON.stringify(next)},trial:true});
        await fixture.waitForFixtureFile(${JSON.stringify(releaseGate)});
        const {maybeRestartService} = await import(${source("../cli/update-cli/update-command-service.ts")});
        const root = ${JSON.stringify(slot)};
        const stamp = async path => JSON.parse(await fs.readFile(path + '/dist/build-info.json','utf8'));
        const result = {status:'ok',mode:'git',root,steps:[],durationMs:0,
          before:await stamp(${JSON.stringify(checkout)}),after:await stamp(root),gitReleaseConversion:publication.rollback};
        let verifiedAt;
        const started = Date.now();
        const outcome = await maybeRestartService({result,shouldRestart:true,opts:{json:true},
          serviceUpdateVerdict:{kind:'owned',root:${JSON.stringify(checkout)},fingerprint:'fixture',refreshDefinition:true,requiresInstallRootRefresh:true},
          refreshServiceEnv:true,serviceEnv:process.env,serviceInstallEnv:process.env,
          gatewayPort:Number(await fs.readFile(${JSON.stringify(portFile)},'utf8')),timeoutMs:15000,
          onVerified: at => {verifiedAt=at;}});
        result.durationMs = Date.now() - started;
        result.status = outcome === 'ok' && verifiedAt ? 'ok' : 'error';
        await fs.writeFile(${JSON.stringify(activationReceipt)}, JSON.stringify({outcome,verifiedAt,result}));
        console.log(JSON.stringify(result));
        if(result.status !== 'ok') process.exitCode = 1;`;
      const entry = `import http from 'node:http'; import fs from 'node:fs';
        await import(${JSON.stringify(loader)});
        const fixture = await import(${support});
        const {version,buildId} = JSON.parse(fs.readFileSync(new URL('./build-info.json', import.meta.url)));
        const portFile = ${JSON.stringify(portFile)}, trial = ${JSON.stringify(trial)};
        if(process.argv.length > 3) {
          const args = ['gateway','install','--force','--port',fs.readFileSync(portFile,'utf8'),'--json'];
          if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(args)) throw Error('Unexpected fixture CLI invocation: '+JSON.stringify(process.argv.slice(2)));
          ${native ? "" : `fixture.registerLinuxFixtureManager(${JSON.stringify(dir)}, ${JSON.stringify(label)});`}
          const {installLaunchAgent} = await import(${source("../daemon/launchd-install.ts")});
          try {
            await installLaunchAgent({env:${JSON.stringify(env)},programArguments:${JSON.stringify(successor)},stdout:process.stderr});
          } catch (error) {console.log(JSON.stringify({action:'install',ok:false,error:String(error)}));process.exitCode=1;}
        } else {
        const {settleGitReleaseTrial} = await import(${source("./git-release.ts")});
        let attempts = 0, rpcHealth = 0, readyz = 0;
        const server = http.createServer(async (req,res) => {
          if (req.method === 'POST' && req.url === ${JSON.stringify("/" + trigger)} && buildId === ${JSON.stringify(before)}) {
            try {
              ${native ? "" : `fixture.registerLinuxJobObservation(${JSON.stringify(dir)}, ${JSON.stringify(new URL("../daemon/service-process-membership.js", resolveRuntimeWorkerUrl(updateExecutorEntrypoints.handoff)).href)});`}
              const {registerSealedRuntime}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.sealedRegistry).href)});
              registerSealedRuntime({json5:undefined,resolveSecureTempRoot:()=>${JSON.stringify(dir)}});
              const handoff=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.handoff).href)});
              const started=await handoff.startManagedServiceUpdateHandoff({root:${JSON.stringify(checkout)},
                supervisor:"launchd",execPath:process.execPath,argv1:${JSON.stringify(updater)},
                env:process.env,restartDrainTimeoutMs:1000,meta:{}});
              if(started.status!=='started' || !await handoff.transferManagedServiceUpdateHandoff({kind:'managed-update-handoff',...started})) throw Error('ownership transfer not acknowledged');
              fs.writeFileSync(${JSON.stringify(handoffReceipt)}, JSON.stringify(started));
              res.end(String(process.pid));
            } catch (e) {res.statusCode=500;res.end(String(e));} return;
          }
          if (req.url === '/readyz') {readyz++;res.end(JSON.stringify({ready:true}));return;}
          if (req.url === '/startupz') {res.end(JSON.stringify({ok:true,status:'started',version,buildId}));return;}
          res.end(JSON.stringify({pid:process.pid, buildId, attempts,rpcHealth,readyz}));
        });
        await fixture.serveFixtureHealth(server,version,buildId,${JSON.stringify(probeToken)},()=>rpcHealth++);
        server.listen(fs.existsSync(portFile) ? Number(fs.readFileSync(portFile)) : 0,'127.0.0.1',async () => {
          if (buildId === ${JSON.stringify(target)}) {
            attempts = JSON.parse(fs.readFileSync(trial)).attempts;
            await settleGitReleaseTrial(${JSON.stringify(slot)});
          }
          fs.writeFileSync(portFile,String(server.address().port));
        });}`;
      async function writeBuild(root: string, buildId: string) {
        await fs.mkdir(path.join(root, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", type: "module", version: "2026.11.4" }),
        );
        await fs.writeFile(
          path.join(root, "dist", "build-info.json"),
          JSON.stringify({ version: "2026.11.4", buildId }),
        );
        await fs.writeFile(path.join(root, "dist", "index.js"), entry);
      }
      await writeBuild(checkout, before);
      await fs.mkdir(path.join(checkout, ".git"));
      await fs.writeFile(updater, updateSource);
      await writeBuild(next, target);
      const previous = (await createGitReleaseDirs(prefix)).releaseRoot;
      await writeBuild(previous, before);
      await publishGitRelease({ prefix, releaseRoot: previous, trial: false });
      const original = command(path.join(checkout, "dist/index.js"));
      await fs.mkdir(path.dirname(plist), { recursive: true });
      await fs.writeFile(
        plist,
        buildLaunchAgentPlist({
          label,
          programArguments: original,
          environment: env,
          stdoutPath: path.join(dir, "stdout"),
          stderrPath: path.join(dir, "stderr"),
        }),
        { flag: "wx" },
      );
      ownsPlist = true;
      if (native) {
        const { logDir, stdoutPath, stderrPath } = resolveGatewaySupervisorLogPaths(env);
        await fs.mkdir(logDir, { recursive: true });
        for (const file of [stdoutPath, stderrPath]) {
          await fs.writeFile(file, "", { flag: "wx", mode: 0o600 });
          ownedSupervisorLogs.push(file);
        }
        expect((await launchctl.execLaunchctl(["bootstrap", domain, plist])).code).toBe(0);
        registered = true;
      } else {
        // launchctl only announces the private helper registration. Its service
        // process must be a sibling of the incumbent, not a detached descendant.
        await fs.writeFile(
          path.join(dir, "launchctl"),
          `#!/bin/sh
set -eu
[ "$1" = bootstrap ] && [ "$2" = ${JSON.stringify(domain)} ] || exit 1
case "$3" in "$TMPDIR"/*/handoff.plist) ;; *) exit 1;; esac
printf '%s' "$3" > "$TMPDIR/helper-plist"
while [ ! -e "$TMPDIR/helper-listening" ]; do sleep .025; done
`,
          { mode: 0o700 },
        );
        service = start(original, dir, env);
        await fs.writeFile(path.join(dir, "manager.pid"), String(service.pid));
        await fs.writeFile(path.join(dir, "manager.command"), JSON.stringify(original));
      }
      await waitForFixtureFile(portFile);
      const port = await fs.readFile(portFile, "utf8");
      const probe = async () => {
        const res = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) });
        return (await res.json()) as {
          pid: number;
          buildId: string;
          attempts: number;
          rpcHealth: number;
          readyz: number;
        };
      };
      const old = await probe();
      await expect(fs.access(trial)).rejects.toMatchObject({ code: "ENOENT" });
      expect(old.buildId).toBe(before);
      const pendingRequest = fetch(`http://127.0.0.1:${port}/${trigger}`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      });
      if (!native) {
        await waitForFixtureFile(path.join(dir, "helper-plist"));
        const helperPlist = await fs.readFile(path.join(dir, "helper-plist"), "utf8");
        const args = fixtureProgramArguments(await fs.readFile(helperPlist, "utf8")).slice(5);
        const socketPath = path.join(path.dirname(helperPlist), "ctl");
        helperJob = start(
          [
            "python3",
            "-c",
            `import os, socket, sys
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1)
os.dup2(s.fileno(), 0); os.execv(sys.argv[2], sys.argv[2:])`,
            socketPath,
            ...args,
          ],
          path.dirname(helperPlist),
          env,
        );
        await fs.writeFile(path.join(dir, "helper.pid"), String(helperJob.pid));
        await waitForFixtureFile(socketPath);
        await fs.writeFile(path.join(dir, "helper-listening"), "");
      }
      expect(await (await pendingRequest).text()).toBe(String(old.pid));
      await expect
        .poll(
          async () =>
            fs.readFile(trial, "utf8").then(
              (text) => JSON.parse(text).attempts,
              () => null,
            ),
          { timeout: 15000 },
        )
        .toBe(0);
      expect(await probe()).toEqual(old);
      expect(await fs.realpath(slot)).toBe(next);
      await fs.writeFile(releaseGate, "go");
      if (!native) {
        await waitForFixtureFile(path.join(dir, "bootout"));
        await stop(service);
        await fs.rm(path.join(dir, "manager.pid"));
        await fs.writeFile(path.join(dir, "bootout.done"), "");
        await waitForFixtureFile(path.join(dir, "bootstrap"));
        const args = fixtureProgramArguments(await fs.readFile(plist, "utf8"));
        service = start(args, dir, env);
        await fs.writeFile(path.join(dir, "manager.pid"), String(service.pid));
        await fs.writeFile(path.join(dir, "manager.command"), JSON.stringify(args));
        await fs.writeFile(path.join(dir, "bootstrap.done"), "");
      }
      await expect
        .poll(async () => (await probe().catch(() => null))?.buildId, { timeout: 15_000 })
        .toBe(target);
      const running = await probe();
      expect(running.pid).not.toBe(old.pid);
      expect(running.attempts).toBe(1);
      const { logPath } = JSON.parse(await fs.readFile(handoffReceipt, "utf8")) as {
        logPath: string;
      };
      await expect
        .poll(() => fs.readFile(logPath, "utf8"), { timeout: 15000 })
        .toContain("managed update helper completed code=0");
      expect(JSON.parse(await fs.readFile(activationReceipt, "utf8"))).toMatchObject({
        outcome: "ok",
        verifiedAt: expect.any(Number),
        result: {
          status: "ok",
          before: { buildId: before },
          after: { buildId: target },
          steps: [
            { name: "managed-service-install", exitCode: 0 },
            { name: "gateway verification", exitCode: 0 },
          ],
        },
      });
      const verified = await probe();
      expect(verified.pid).toBe(running.pid);
      expect(verified.buildId).toBe(target);
      expect(verified.rpcHealth).toBeGreaterThan(0);
      expect(verified.readyz).toBeGreaterThan(0);
      expect(fixtureProgramArguments(await fs.readFile(plist, "utf8"))).toContain(successor.at(-2));
      expect(await fs.realpath(slot)).toBe(next);
      await expect(fs.access(trial)).rejects.toMatchObject({ code: "ENOENT" });
    } catch (error) {
      const receipt = await fs
        .readFile(path.join(dir, "handoff-receipt"), "utf8")
        .catch(() => null);
      if (receipt) {
        const log = await fs.readFile(JSON.parse(receipt).logPath, "utf8").catch(() => "");
        throw new Error(`Scratch handoff diagnostics: ${log}`, { cause: error });
      }
      throw error;
    } finally {
      if (native && registered) {
        const helperXml = await fs
          .readFile(path.join(dir, "handoff-receipt"), "utf8")
          .then((receipt) =>
            fs.readFile(
              path.join(path.dirname(JSON.parse(receipt).logPath), "handoff.plist"),
              "utf8",
            ),
          )
          .catch(() => "");
        const helperLabel =
          /<key>Label<\/key><string>(ai\.openclaw\.update\.[0-9a-f-]{36})<\/string>/.exec(
            helperXml,
          )?.[1];
        if (helperLabel) {
          await launchctl.execLaunchctl(["bootout", `${domain}/${helperLabel}`]);
        }
        await launchctl.execLaunchctl(["bootout", `${domain}/${label}`]);
      }
      await Promise.all(ownedSupervisorLogs.map((file) => fs.rm(file, { force: true })));
      if (native && ownsPlist) {
        await fs.rm(plist, { force: true });
      }
      if (native && ownsState) {
        await fs.rm(env.OPENCLAW_STATE_DIR, { force: true, recursive: true });
      }
      await stop(service);
      await stop(helperJob);
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  45_000,
);
