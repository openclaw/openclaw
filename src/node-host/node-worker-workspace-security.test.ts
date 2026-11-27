import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNodeWorkspaceTransferService } from "../gateway/worker-environments/node-workspace-transfer-service.js";
import {
  startNodeWorkspaceTransferTestServer,
  transferOwner,
} from "../gateway/worker-environments/node-workspace-transfer.test-support.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { AUTHENTICATED_REF_REFRESH_JS } from "../worker/workspace-git-policy.js";
import { withNodeWorkerFilesystemCommands } from "./node-worker-command-filesystem.js";
import { prepareNodeWorkerFilesystem } from "./node-worker-filesystem.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
it.runIf(process.platform === "linux")(
  "a confined repository cannot cause the unconfined Git-history owner to execute it",
  async () => {
    const root = dirs.make("pr193823-git-boundary-");
    const workspace = path.join(root, "workspace"),
      source = path.join(root, "source"),
      hostHome = path.join(root, "home"),
      bundleRoot = path.join(root, "bundles");
    for (const p of [workspace, source, hostHome, bundleRoot]) {
      fs.mkdirSync(p, { mode: 0o700 });
    }
    const env = {
      PATH: process.env.PATH,
      HOME: hostHome,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Audit",
      GIT_AUTHOR_EMAIL: "audit@invalid",
      GIT_COMMITTER_NAME: "Audit",
      GIT_COMMITTER_EMAIL: "audit@invalid",
    };
    const git = (args: string[]) => {
      const r = spawnSync("git", ["-C", source, ...args], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git(["init", "-q"]);
    fs.writeFileSync(path.join(source, "file"), "base");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    const service = createNodeWorkspaceTransferService({
      getOwner: () => transferOwner("session"),
      temporaryRoot: path.join(root, "transfers"),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    const prepared = await service.prepareSync({
      environmentId: "audit",
      ownerEpoch: 1,
      sessionId: "session",
      localPath: source,
      isAuthorized: () => true,
    });
    const run = (transfer: Parameters<typeof runNodeWorkerWorkspaceTransfer>[0]["transfer"]) =>
      runNodeWorkerWorkspaceTransfer({
        environmentId: "audit",
        workspaceDir: workspace,
        manifestHome: hostHome,
        gatewayUrl: server.gatewayUrl,
        transfer,
        isolation: { bundleRoot, env },
      });
    await run({
      direction: "download",
      token: prepared.token,
      manifestRef: prepared.snapshot.manifestRef,
    });
    const marker = path.join(root, "outside-marker");
    const helperBody = "#!/bin/sh\nprintf escaped > " + JSON.stringify(marker) + "\nexit 1\n";
    const code =
      "import fs from 'node:fs';import{spawnSync}from'node:child_process';const w=" +
      JSON.stringify(workspace) +
      ";const marker=" +
      JSON.stringify(marker) +
      ";const env={...process.env,GIT_AUTHOR_NAME:'Audit',GIT_AUTHOR_EMAIL:'audit@invalid',GIT_COMMITTER_NAME:'Audit',GIT_COMMITTER_EMAIL:'audit@invalid'};const git=a=>{const r=spawnSync('git',['-C',w,...a],{env,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim()};let denied;try{fs.writeFileSync(marker,'direct')}catch(e){denied=e.code};if(denied!=='EACCES')throw Error('direct write was not denied');fs.writeFileSync(w+'/file','next');git(['add','.']);git(['commit','-qm','next']);const blob=git(['rev-parse','HEAD:file']);fs.unlinkSync(w+'/.git/objects/'+blob.slice(0,2)+'/'+blob.slice(2));git(['config','extensions.partialClone','origin']);git(['config','remote.origin.promisor','true']);git(['config','remote.origin.url','ssh://audit.invalid/repo']);const helper=w+'/audit-ssh';fs.writeFileSync(helper," +
      JSON.stringify(helperBody) +
      ",{mode:0o700});git(['config','core.sshCommand',helper]);console.log(JSON.stringify({denied}));";
    const launch = await prepareNodeWorkerFilesystem({
      workspaceDir: workspace,
      bundleRoot,
      entry: path.join(
        process.cwd(),
        "src/node-host/node-worker-workspace-git-history.generated.worker.mjs",
      ),
      homeDir: hostHome,
      env,
      args: ["--input-type=module", "-e", code],
    });
    try {
      const r = spawnSync(launch.command, launch.args, { env, encoding: "utf8", timeout: 20000 });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ denied: "EACCES" });
      const token = service.prepareUpload("audit", prepared.snapshot.manifestRef, undefined, 2);
      await run({
        direction: "upload",
        token,
        baseManifestRef: prepared.snapshot.manifestRef,
        referenceManifestRef: prepared.snapshot.manifestRef,
        resultVersion: 2,
      });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      await launch.cleanup();
      await server.close();
      await service.closeAll();
    }
  },
);

it.runIf(process.platform === "linux")(
  "does not export a host-only repository selected by worker gitdir metadata",
  async () => {
    const root = dirs.make("pr193823-disclosure-");
    const source = path.join(root, "source"),
      privateRepo = path.join(root, "private"),
      workspace = path.join(root, "workspace"),
      hostHome = path.join(root, "home"),
      bundleRoot = path.join(root, "bundles");
    for (const p of [source, privateRepo, workspace, hostHome, bundleRoot]) {
      fs.mkdirSync(p, { mode: 0o700 });
    }
    const env = {
      PATH: process.env.PATH,
      HOME: hostHome,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Audit",
      GIT_AUTHOR_EMAIL: "audit@invalid",
      GIT_COMMITTER_NAME: "Audit",
      GIT_COMMITTER_EMAIL: "audit@invalid",
    };
    const git = (cwd: string, args: string[]) => {
      const r = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git(source, ["init", "-q"]);
    fs.writeFileSync(path.join(source, "file"), "base");
    git(source, ["add", "."]);
    git(source, ["commit", "-qm", "base"]);
    git(privateRepo, ["clone", "-q", source, "."]);
    fs.writeFileSync(path.join(privateRepo, "host-only.txt"), "synthetic-private-content");
    git(privateRepo, ["add", "."]);
    git(privateRepo, ["commit", "-qm", "private"]);
    const privateHead = git(privateRepo, ["rev-parse", "HEAD"]);
    const service = createNodeWorkspaceTransferService({
      getOwner: () => transferOwner("session"),
      temporaryRoot: path.join(root, "transfers"),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    const prepared = await service.prepareSync({
      environmentId: "disclosure",
      ownerEpoch: 1,
      sessionId: "session",
      localPath: source,
      isAuthorized: () => true,
    });
    const run = (transfer: Parameters<typeof runNodeWorkerWorkspaceTransfer>[0]["transfer"]) =>
      runNodeWorkerWorkspaceTransfer({
        environmentId: "disclosure",
        workspaceDir: workspace,
        manifestHome: hostHome,
        gatewayUrl: server.gatewayUrl,
        transfer,
        isolation: { bundleRoot, env },
      });
    await run({
      direction: "download",
      token: prepared.token,
      manifestRef: prepared.snapshot.manifestRef,
    });
    const code =
      "import fs from 'node:fs';const w=" +
      JSON.stringify(workspace) +
      ";const p=" +
      JSON.stringify(privateRepo) +
      ";let denied;try{fs.readFileSync(p+'/host-only.txt')}catch(e){denied=e.code}if(denied!=='EACCES')throw Error('private read not denied');fs.rmSync(w+'/.git',{recursive:true,force:true});fs.writeFileSync(w+'/.git','gitdir: '+p+'/.git'+String.fromCharCode(10));console.log(JSON.stringify({denied}));";
    const launch = await prepareNodeWorkerFilesystem({
      workspaceDir: workspace,
      bundleRoot,
      entry: path.join(
        process.cwd(),
        "src/node-host/node-worker-workspace-git-history.generated.worker.mjs",
      ),
      homeDir: hostHome,
      env,
      args: ["--input-type=module", "-e", code],
    });
    try {
      const r = spawnSync(launch.command, launch.args, { env, encoding: "utf8", timeout: 20000 });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ denied: "EACCES" });
      const token = service.prepareUpload(
        "disclosure",
        prepared.snapshot.manifestRef,
        undefined,
        2,
      );
      let error: string | undefined;
      try {
        await run({
          direction: "upload",
          token,
          baseManifestRef: prepared.snapshot.manifestRef,
          referenceManifestRef: prepared.snapshot.manifestRef,
          resultVersion: 2,
        });
      } catch (e) {
        error = String(e);
      }
      let exported = false;
      if (!error) {
        const uploaded = service.takeUpload("disclosure", prepared.snapshot.manifestRef);
        exported = uploaded.gitHistory?.headCommit === privateHead && Boolean(uploaded.gitPackPath);
      }
      expect(exported).toBe(false);
    } finally {
      await launch.cleanup();
      await server.close();
      await service.closeAll();
    }
  },
);

it.runIf(process.platform === "linux")(
  "pins the active-repository refresh runtime and Git ahead of model HOME",
  async () => {
    const root = dirs.make("pr193823-refresh-runtime-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    const runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(home, "state", "node-host"),
      env: {
        PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? ""),
        HOME: home,
      },
      filesystemIsolation: true,
    });
    const identity = {
      gatewayNamespace: "gateway",
      environmentId: "environment",
      sessionId: "session",
      generation: 1,
    };
    const setup = await runtime.exec({
      ...identity,
      argv: [
        path.basename(process.execPath),
        "-e",
        String.raw`
    const fs = require("node:fs"); const path = require("node:path");
    const bin = path.join(process.env.HOME, ".local", "bin");
    fs.mkdirSync(bin, {recursive:true});
    for (const name of ["node", "git"]) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nprintf selected > \"$PWD/selected-" + name + "\"\nexit 42\n", {mode:0o700});
    process.stdout.write(process.cwd());
  `,
      ],
    });
    expect(setup.code, setup.stderr).toBe(0);
    const workspace = setup.workspaceDir;
    const git = (args: string[]) => {
      const result = spawnSync(
        "git",
        [
          "-C",
          workspace,
          "-c",
          "user.name=Audit",
          "-c",
          "user.email=audit@invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git(["init", "-q"]);
    fs.writeFileSync(path.join(workspace, "file"), "base");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    const baseCommit = git(["rev-parse", "HEAD"]);
    const control = await runtime.exec({
      ...identity,
      argv: [
        path.basename(process.execPath),
        "-e",
        'process.exit(require("node:child_process").spawnSync("git", ["--version"], {stdio:"inherit"}).status ?? 1)',
      ],
    });
    expect(control.code).toBe(42);
    fs.unlinkSync(path.join(workspace, "selected-git"));
    const server = createNetServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address === "object");
    try {
      const refreshed = await runtime.exec({
        ...identity,
        argv: ["node", "-e", AUTHENTICATED_REF_REFRESH_JS],
        input: JSON.stringify({
          origin: `https://127.0.0.1:${address.port}/repository.git`,
          token: "synthetic-refresh-token",
          baseCommit,
        }),
        nativeProcessOwner: true,
        timeoutMs: 10000,
      });
      expect(refreshed.code).not.toBe(0);
      expect(refreshed.code).not.toBe(42);
      expect(fs.existsSync(path.join(workspace, "selected-node"))).toBe(false);
      expect(fs.existsSync(path.join(workspace, "selected-git"))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);

it.runIf(process.platform === "linux")(
  "keeps Git metadata replacement and filter execution inside the admitted filesystem",
  async () => {
    const root = dirs.make("pr193823-git-command-boundary-");
    const workspace = path.join(root, "workspace");
    const privateRepo = path.join(root, "private");
    const homeDir = path.join(root, "home");
    const bundleRoot = path.join(root, "bundles");
    for (const directory of [workspace, privateRepo, homeDir, bundleRoot]) {
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    const env = {
      PATH: process.env.PATH,
      HOME: homeDir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (cwd: string, args: string[], input?: string) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { env, input, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git(workspace, ["init", "-q"]);
    git(privateRepo, ["init", "-q"]);
    const privateBlob = git(
      privateRepo,
      ["hash-object", "-w", "--stdin"],
      "synthetic-host-only-object",
    );
    const actor = await prepareNodeWorkerFilesystem({
      workspaceDir: workspace,
      bundleRoot,
      homeDir,
      env,
      entry: process.execPath,
      args: [
        "-e",
        'const fs=require("node:fs");fs.renameSync(".git/objects",".git/original-objects");fs.symlinkSync(process.argv[1],".git/objects","dir")',
        path.join(privateRepo, ".git", "objects"),
      ],
    });
    try {
      const result = await withNodeWorkerFilesystemCommands(
        { isolation: { bundleRoot, env }, workspaceDir: workspace, homeDir, env },
        async () => {
          // Replace metadata only after the command owner has prepared its filesystem grants.
          const changed = spawnSync(actor.command, actor.args, { env, encoding: "utf8" });
          expect(changed.status, changed.stderr).toBe(0);
          return await runCommandWithTimeout(["git", "cat-file", "blob", privateBlob], {
            cwd: workspace,
            baseEnv: env,
            timeoutMs: 10000,
          });
        },
      );
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("synthetic-host-only-object");
    } finally {
      await actor.cleanup();
      fs.unlinkSync(path.join(workspace, ".git", "objects"));
      fs.renameSync(
        path.join(workspace, ".git", "original-objects"),
        path.join(workspace, ".git", "objects"),
      );
    }
    const marker = path.join(root, "filter-escaped");
    const filter = path.join(workspace, "filter-helper");
    fs.writeFileSync(filter, "#!/bin/sh\nprintf escaped > " + JSON.stringify(marker) + "\ncat\n", {
      mode: 0o700,
    });
    fs.writeFileSync(path.join(workspace, ".gitattributes"), "file filter=audit\n");
    const argv = [
      "git",
      "-c",
      "filter.audit.clean=" + filter,
      "-c",
      "filter.audit.required=true",
      "hash-object",
      "--path=file",
      "--stdin",
    ];
    const control = spawnSync(argv[0]!, argv.slice(1), {
      cwd: workspace,
      env,
      input: "payload",
      encoding: "utf8",
    });
    expect(control.status, control.stderr).toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("escaped");
    fs.unlinkSync(marker);
    const filtered = await withNodeWorkerFilesystemCommands(
      { isolation: { bundleRoot, env }, workspaceDir: workspace, homeDir, env },
      () =>
        runCommandWithTimeout(argv, {
          cwd: workspace,
          baseEnv: env,
          input: "payload",
          timeoutMs: 10000,
        }),
    );
    expect(fs.existsSync(marker)).toBe(false);
    expect(filtered.stderr).toMatch(/permission denied/i);
  },
);
