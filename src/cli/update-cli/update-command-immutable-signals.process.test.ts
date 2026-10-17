import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import {
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "../cli-process-child.test-helpers.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const entry = (sourceWorkerName: string, distWorkerPath: string) =>
  resolveRuntimeWorkerUrl({ currentModuleUrl: import.meta.url, sourceWorkerName, distWorkerPath });
const command = entry("update-command", "cli/update-cli/update-command.js");
const recordOwner = entry(
  "../../infra/package-update-activation-immutable",
  "infra/package-update-activation-immutable.js",
);
const recordReader = entry(
  "../../infra/update-immutable-install-record",
  "infra/update-immutable-install-record.js",
);
const activationPaths = entry(
  "../../infra/package-update-activation-paths",
  "infra/package-update-activation-paths.js",
);
const exec = entry("../../process/exec", "process/exec.js");
const cleanup = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.cliCleanupScope);
const finalization = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.oneShotExit);
const sourceArgs = command.pathname.endsWith(".ts") ? ["--import", "./scripts/tsx.mjs"] : [];

it.skipIf(process.platform === "win32").each([
  { signal: "SIGTERM", dryRun: false },
  { signal: "SIGINT", dryRun: true },
] as const)(
  "cancels immutable main discovery before retry on $signal (dryRun=$dryRun)",
  async ({ signal, dryRun }) => {
    const parent = fs.realpathSync(dirs.make("immutable-update-signal-"));
    fs.chmodSync(parent, 0o755);
    const root = path.join(parent, "installation");
    const sha = "a".repeat(40);
    const generation = path.join(root, "releases", sha);
    fs.mkdirSync(generation, { recursive: true, mode: 0o755 });
    fs.symlinkSync(`releases/${sha}`, path.join(root, "current"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw"}');
    fs.writeFileSync(path.join(generation, "payload"), "original sealed generation");
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        // A real settled HTTP 503 enters the production Git retry backoff.
        response.writeHead(503, { Connection: "close" });
        response.end("synthetic Git service temporarily unavailable");
      } else {
        response.writeHead(500, { Connection: "close" });
        response.end("unexpected retry after interruption");
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Git fixture did not obtain a loopback port");
    }
    const remote = `http://127.0.0.1:${address.port}/repo.git`;
    const caller = path.join(root, "immutable.mjs");
    const baseline = path.join(parent, "journal-before");
    const journalPath = path.join(parent, "journal-path");
    fs.writeFileSync(
      caller,
      `
      import fs from 'node:fs';
      import path from 'node:path';
      import {registerHooks} from 'node:module';
      const parent=${JSON.stringify(parent)}, root=${JSON.stringify(root)};
      // Only project root ownership for this isolated layout. The record writer,
      // SQLite bytes, filesystem identities, Git and CLI signal exit remain real.
      const lstat=fs.lstatSync;
      fs.lstatSync=(file,...args)=>{
        const stat=lstat(file,...args);
        if(stat && (String(file)===parent || String(file).startsWith(parent+path.sep))) {
          Object.defineProperty(stat,'uid',{value:typeof stat.uid==='bigint'?0n:0});
        }
        return stat;
      };
      const identity=file=>{const s=fs.lstatSync(file);return s.dev+':'+s.ino;};
      const {packageActivationRuntimeIdentity,resolvePackageActivationAnchor,resolvePackageActivationJournalPath}=await import(${JSON.stringify(activationPaths.href)});
      const {createImmutableInstallRecord}=await import(${JSON.stringify(recordOwner.href)});
      const runtime=fs.realpathSync(process.execPath);
      const record=createImmutableInstallRecord({
        version:1,kind:'immutable',root,rootIdentity:identity(root),releasesIdentity:identity(path.join(root,'releases')),
        current:{sha:${JSON.stringify(sha)},path:${JSON.stringify(generation)},identity:identity(${JSON.stringify(generation)}),pointerIdentity:identity(path.join(root,'current')),buildDigest:'c'.repeat(64)},
        runtime:{path:runtime,identity:packageActivationRuntimeIdentity(runtime)},source:'https://github.com/openclaw/openclaw.git',
        service:{unit:'synthetic.service',scope:'system',account:'synthetic',stateDir:path.join(parent,'state'),configPath:path.join(parent,'state/openclaw.json'),profile:null},
      },()=>{});
      const journal=resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root));
      fs.writeFileSync(${JSON.stringify(baseline)},fs.readFileSync(journal));
      fs.writeFileSync(${JSON.stringify(journalPath)},journal);
      registerHooks({load(url,context,next){
        // Fixed external I/O: read the real adoption writer's fixture record
        // without a privileged worker, and route official Git traffic to loopback.
        if(url===${JSON.stringify(recordReader.href)}) return {format:'module',shortCircuit:true,
          source:'export async function readImmutableInstallRecord(){return '+JSON.stringify(record)+';}'};
        if(url===${JSON.stringify(exec.href)}) return {format:'module',shortCircuit:true,
          source:'export * from '+JSON.stringify(url+'?fixture-original')+'; import {runCommandWithTimeout as real} from '+JSON.stringify(url+'?fixture-original')+'; export const runCommandWithTimeout=(argv,options)=>real(argv.map(a=>a==="https://github.com/openclaw/openclaw.git"?'+JSON.stringify(${JSON.stringify(remote)})+':a),options);'};
        return next(url,context);
      }});
      const {updateCommand}=await import(${JSON.stringify(command.href)});
      const {withCliProcessScope,withCliCommandCleanup}=await import(${JSON.stringify(cleanup.href)});
      const {runCliWithExitFinalization}=await import(${JSON.stringify(finalization.href)});
      let resources;
      await withCliProcessScope(()=>runCliWithExitFinalization({
        run:()=>withCliCommandCleanup(false,async c=>{resources=c.pluginResources;await updateCommand({dryRun:${dryRun},json:true,restart:false});}),
        onError:error=>process.stderr.write(String(error)+'\\n'),
        finalize:async()=>{await resources?.release();},
      }));
      fs.writeFileSync(${JSON.stringify(path.join(parent, "unwound"))},'settled');
      `,
    );
    try {
      const result = await runCliProcessChild({
        nodeArgs: [...sourceArgs, caller],
        nodeExecutable: resolveTestNodeExecPath(),
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_TEST_RUNTIME_LOG: "1",
          OPENCLAW_TEST_CONSOLE: "1",
          OPENCLAW_STATE_DIR: path.join(parent, "state"),
          OPENCLAW_CONFIG_PATH: path.join(parent, "state/openclaw.json"),
          OPENCLAW_UPDATE_RUN_ID: undefined,
          OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
          OPENCLAW_UPDATE_POST_CORE: undefined,
        },
        interact: async (child) => {
          await waitForCliProcessStderrMarker(
            child,
            "Git ls-remote hit a transient failure; retrying once",
          );
          expect(child.kill(signal)).toBe(true);
        },
      });
      expect(result.stderr).toContain("operation=ls-remote attempt=1 maxAttempts=2");
      expect(requests, result.stderr).toBe(1);
      expect(result.code).toBe(signal === "SIGTERM" ? 143 : 130);
      expect(result.signal).toBeNull();
      expect(result.stderr).not.toContain("CLI signal cleanup did not complete");
      expect(fs.readFileSync(path.join(parent, "unwound"), "utf8")).toBe("settled");
      expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
      expect(fs.readFileSync(path.join(generation, "payload"), "utf8")).toBe(
        "original sealed generation",
      );
      expect(fs.readFileSync(fs.readFileSync(journalPath, "utf8"))).toEqual(
        fs.readFileSync(baseline),
      );
      expect(fs.existsSync(path.join(parent, "state"))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
