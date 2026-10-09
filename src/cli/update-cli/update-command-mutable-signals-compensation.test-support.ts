import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { buildMinimalGatewayHelloOkPayload } from "../../gateway/minimal-gateway.test-helpers.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { triageMaintenanceRuntimeEntrypoints } from "../../infra/triage-runtime.test-support.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

/** Native service adapter outlives the signaled driver, so recovery is observable after exit. */
export async function createMutableInterruptionService(packageRoot: string, signal: AbortSignal) {
  const claim = await acquireTestPortBlock({ offsets: [0, 1], signal });
  const transitions: string[] = [];
  const child = spawn(
    resolveTestNodeExecPath(),
    [
      "--input-type=module",
      "-e",
      `
        import fs from 'node:fs';
        import {createServer} from 'node:http';
        import {WebSocketServer} from ${JSON.stringify(import.meta.resolve("ws"))};
        process.title='openclaw-gateway';
        const version=()=>JSON.parse(fs.readFileSync(${JSON.stringify(path.join(packageRoot, "package.json"))},'utf8')).version;
        const gateway=createServer((_request,response)=>{
          response.setHeader('content-type','application/json');
          response.end(JSON.stringify({ok:true,version:version()}));
        });
        const sockets=new WebSocketServer({server:gateway});
        sockets.on('connection',socket=>{
          socket.send(JSON.stringify({type:'event',event:'connect.challenge',payload:{nonce:'signal-fixture',ts:Date.now()}}));
          socket.on('message',data=>{
            const request=JSON.parse(data.toString());
            if(request.type!=='req'||!request.id)return;
            const hello=${JSON.stringify(buildMinimalGatewayHelloOkPayload({ auth: { role: "operator", scopes: ["operator.read"] } }))};
            const payload=request.method==='connect'
              ? {...hello,server:{...hello.server,version:version(),bootId:'signal-fixture'}}
              : {ok:true,channels:{},plugins:{errors:[],unavailable:[]}};
            socket.send(JSON.stringify({type:'res',id:request.id,ok:true,payload}));
          });
        });
        const listen=server=>new Promise(resolve=>server.listen(server===gateway?${claim.port}:${claim.port + 1},'127.0.0.1',resolve));
        const control=createServer((request,response)=>{
          void (async()=>{
            if(request.url==='/stop'&&gateway.listening){
              for(const socket of sockets.clients)socket.terminate();
              await new Promise(resolve=>gateway.close(resolve));
              process.send('stopped');
            }else if(request.url==='/restart'&&!gateway.listening){
              await listen(gateway);
              process.send('restarted '+version());
            }
            response.setHeader('content-type','application/json');
            response.end(JSON.stringify({running:gateway.listening,pid:process.pid}));
          })().catch(error=>{response.statusCode=500;response.end(String(error));});
        });
        await listen(gateway);await listen(control);process.send({ready:true});
      `,
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: path.resolve(packageRoot, "../../../../../.openclaw"),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics += chunk;
  });
  child.on("message", (message: unknown) => {
    if (typeof message === "string") {
      transitions.push(message);
    }
  });
  const closed = once(child, "close");
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  const close = async () => {
    stop();
    await closed;
    signal.removeEventListener("abort", stop);
    await claim.release();
  };
  try {
    if (signal.aborted) {
      stop();
    }
    await Promise.race([
      once(child, "message"),
      closed.then(() => {
        throw new Error(`Synthetic Gateway exited before ready: ${diagnostics}`);
      }),
    ]);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    port: claim.port,
    controlUrl: `http://127.0.0.1:${claim.port + 1}`,
    transitions,
    close,
  };
}

/** Install service observations before the shared signal child imports the update owners. */
export function mutableCompensationFixtureSource(): string {
  const url = (key: keyof typeof updateExecutorNativeEntrypoints) =>
    JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints[key]).href);
  const stateWorker = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.candidateStateWorker);
  const workerSource = stateWorker.pathname.endsWith(".ts")
    ? "import { tsImport } from " +
      JSON.stringify(import.meta.resolve("tsx/esm/api")) +
      "; await tsImport(" +
      JSON.stringify(stateWorker.href) +
      ", { parentURL: import.meta.url, tsconfig: " +
      JSON.stringify(path.resolve("tsconfig.json")) +
      " });"
    : "await import(" + JSON.stringify(stateWorker.href) + ");";
  return `
    const compensationFixture = !mode.endsWith('-compensation') ? undefined : await (async () => {
      const { mock } = await import('node:test');
      const { inspect } = await import('node:util');
      const os = (await import('node:os')).default;
      const user = os.userInfo();
      os.userInfo = () => ({...user, homedir:root});
      syncBuiltinESMExports();
      const lateRollback = mode === 'rollback-compensation';
      const publishing = mode === 'publishing-compensation' || lateRollback;
      let packageFixture;
      if(publishing) {
        const {createPackageSwapFixture} = await import(${url("packageSwapFixture")});
        packageFixture = await createPackageSwapFixture(root + '/pair');
        const source = ${JSON.stringify(`
          import {json} from 'node:stream/consumers';
          const load = async url => url.endsWith('.ts')
            ? (await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))})).tsImport(url,{parentURL:import.meta.url,tsconfig:${JSON.stringify(path.resolve("tsconfig.json"))}})
            : import(url);
          const {GATEWAY_UPDATE_EXECUTOR_CONTRACT} = await load(${url("serviceAuthority")});
          if(process.argv.includes('check')) {
            process.stdout.write(JSON.stringify({updateExecutor:GATEWAY_UPDATE_EXECUTOR_CONTRACT,targetRootBinding:true,retainedOwnerBinding:true}));
          } else {
            const input=await json(process.stdin);
            const {withDelegatedUpdateCommandExecutor} = await load(${url("executor")});
            await withDelegatedUpdateCommandExecutor(input.executor,input.executor.runId,input.targetRoot,async fence=>{
              fence.assertCurrent();
              const response=await fetch(CONTROL_URL + '/restart',{method:'POST'});
              if(!response.ok) throw new Error(await response.text());
              fence.assertCurrent();
              process.stdout.write(JSON.stringify({ok:true,action:'restart',result:'restarted'}));
            });
          }
        `)}.replace('CONTROL_URL',JSON.stringify(controlUrl));
        for(const packageRoot of [packageFixture.packageRoot,packageFixture.params.stage.packageRoot]) {
          const manifest=JSON.parse(fs.readFileSync(packageRoot + '/package.json','utf8'));
          fs.writeFileSync(packageRoot + '/package.json',JSON.stringify({...manifest,type:'module'}));
          fs.writeFileSync(packageRoot + '/dist/index.js',source);
          fs.writeFileSync(packageRoot + '/openclaw.mjs',"import './dist/index.js';");
        }
      } else {
        fs.writeFileSync(root + '/package.json', JSON.stringify({name:'openclaw',version:'2026.9.1',type:'module'}));
        fs.writeFileSync(root + '/openclaw.mjs', '// synthetic service entry');
      }
      const installRoot = packageFixture?.packageRoot ?? root;
      fs.mkdirSync(stateDir, {recursive:true});
      fs.writeFileSync(configPath, JSON.stringify(publishing ? {gateway:{port:gatewayPort,auth:{mode:'none'}}} : {}));
      for(const packageRoot of publishing ? [installRoot,packageFixture.params.stage.packageRoot] : [root]) {
        fs.mkdirSync(packageRoot + '/dist/infra', {recursive:true});
        fs.writeFileSync(packageRoot + '/dist/infra/update-candidate-state.worker.js', ${JSON.stringify(workerSource)});
        if(publishing) {
          const {writePackageDistInventory}=await import(${url("packageDistInventory")});
          await writePackageDistInventory(packageRoot);
        }
      }
      const marker = name => fs.writeFileSync(root + '/' + name, 'observed');
      let running = true;
      let receiptRun;
      const serviceUrl = ${JSON.stringify(resolveRuntimeWorkerUrl(triageMaintenanceRuntimeEntrypoints.service).href)};
      const serviceModule = await import(serviceUrl);
      const service = {
        label:'fixture service',loadedText:'loaded',notLoadedText:'not loaded',
        isLoaded:async()=>true, isEnabled:async()=>true,
        readCommand:async()=>({
          programArguments:[process.execPath,installRoot+'/openclaw.mjs','gateway','--port',String(gatewayPort ?? 19101)],
          environment:{HOME:root,OPENCLAW_STATE_DIR:stateDir,OPENCLAW_CONFIG_PATH:configPath},
        }),
        readRuntime:async()=>{
          const current=publishing ? await (await fetch(controlUrl)).json() : {running,pid:Math.max(process.pid,process.ppid)+1};
          return {status:current.running?'running':'stopped',pid:current.running?current.pid:undefined,systemd:{managerUid:process.getuid?.()}};
        },
        stop:async args=>{
          args.assertCurrent?.();
          assert.equal(getUpdateRun(receiptRun.runId,{env:receiptRun.env}).phase,'activating');
          marker('compensation-native-stop');running=false;
          if(publishing) await fetch(controlUrl + '/stop',{method:'POST'});
        },
      };
      mock.module(serviceUrl,{namedExports:{...serviceModule,resolveGatewayService:()=>service}});
      const membershipUrl = ${url("serviceMembership")};
      mock.module(membershipUrl,{namedExports:{...(await import(membershipUrl)),inspectServiceProcessMembershipSync:()=> 'outside'}});
      const maintenanceUrl = ${url("systemdMaintenance")};
      mock.module(maintenanceUrl,{namedExports:{...(await import(maintenanceUrl)),prepareSystemdGatewayMaintenance:async()=>false}});
      const drainUrl = ${url("serviceDrain")};
      mock.module(drainUrl,{namedExports:{...(await import(drainUrl)),withGatewayMaintenanceDrain:async(_params,stop)=>await stop()}});
      return async ({run,currentOptions,ready}) => {
        receiptRun=run;
        // Admission used the external-supervisor branch. Only this synthetic service becomes
        // mutable after acquiring the real invocation and executor.
        delete process.env.OPENCLAW_SUPERVISOR_MODE;
        delete run.env.OPENCLAW_SUPERVISOR_MODE;
        const {createConfigIO} = await import(${url("configIO")});
        const {readUpdateStateSchemaVersions} = await import(${url("candidateState")});
        const {maybeStopManagedServiceBeforeMutableUpdate} = await import(${url("serviceMaintenance")});
        const {finishUpdate} = await import(${url("postUpdate")});
        const {registerSignalExitGate} = await import(${url("signalExitBarrier")});
        const {hasCommandProcessCleanupError} = await import(${url("commandCleanup")});
        const configSnapshot = await createConfigIO({env:run.env,pluginValidation:'skip'}).readConfigFileSnapshot();
        const schemaVersions = await readUpdateStateSchemaVersions({stateDir,config:configSnapshot.sourceConfig,env:run.env});
        const before = await maybeStopManagedServiceBeforeMutableUpdate({root:installRoot,updateInstallKind:'package',shouldRestart:true,jsonMode:true,phase:'inspect',updateRun:run,timeoutMs:1000});
        assert.equal(before.serviceUpdateVerdict?.kind,'owned',JSON.stringify({
          inspected:before.inspected,runtimeInspected:before.runtimeInspected,
          serviceMutationAllowed:before.serviceMutationAllowed,
          serviceMutationSkipMessage:before.serviceMutationSkipMessage,
          blockMessage:before.blockMessage,serviceUpdateVerdict:before.serviceUpdateVerdict,
        }));
        if(publishing) {
          const {swapStagedPackageInstall} = await import(${url("packageSwap")});
          const guards=createUpdateCommandExecutionGuards(currentOptions,installRoot);
          let transaction;
          let stopped;
          const nativeFs=await import('node:fs/promises');
          const rename=nativeFs.default.rename;
          const holdRename=selected=>{
            nativeFs.default.rename=async(from,to)=>{
              await rename(from,to);
              if(String(from)===selected) {
                nativeFs.default.rename=rename;
                const interrupted=new Promise(resolve=>process.once('message',resolve));
                ready();
                await interrupted;
              }
            };
          };
          if(!lateRollback)holdRename(installRoot);
          let swapped;
          try {
            swapped=await swapStagedPackageInstall({
              ...packageFixture.params,
              assertCurrent:()=>run.executorFence.assertCurrent(),
              beforeActivate:async()=>{
                await guards.recordPhase('activating');
                stopped=await maybeStopManagedServiceBeforeMutableUpdate({root:installRoot,updateInstallKind:'package',shouldRestart:true,jsonMode:true,expectedService:before,updateRun:run,recordPhase:guards.recordPhase,assertCurrent:guards.assertCurrent,timeoutMs:1000});
                assert.equal(stopped.stopped,true,JSON.stringify(stopped));
              },
              onTransaction:retained=>{transaction=retained;},
            });
          } finally {nativeFs.default.rename=rename;}
          assert.equal(swapped.status,'committed',JSON.stringify(swapped));
          assert.equal(stopped.stopped,true);
          const verificationFailure={name:'candidate verification',command:'openclaw update',cwd:installRoot,durationMs:0,exitCode:1,stderrTail:'Synthetic candidate verification failed.'};
          if(lateRollback)holdRename(transaction.backupRoot);
          try {await finishUpdate({
            root:installRoot,mutationStarted:true,installKindChanged:false,
            result:{status:lateRollback?'error':'ok',mode:'npm',root:installRoot,before:{version:'1.0.0'},after:{version:'2.0.0'},steps:lateRollback?[swapped.step,verificationFailure]:[swapped.step],durationMs:1,...(lateRollback?{reason:'candidate-verification-failed',failedStep:verificationFailure}:{})},
            configSnapshot,schemaVersions,previousSchemaVersions:{state:999,agent:999},previousVerified:true,
            requestedChannel:null,storedChannel:'stable',channel:'stable',downgradeRisk:false,shouldRestart:true,opts:currentOptions,
            ownedManagedUpdateEnv:run.env,preManagedServiceStop:stopped,packageTransaction:transaction,
            controlPlaneUpdateSentinelMeta:null,preUpdatePluginInstallRecords:{},startedAt:Date.now(),updateStepTimeoutMs:10000,
          });}finally{nativeFs.default.rename=rename;}
          return;
        }
        const {recordUpdateRunStepAsync} = await import(${url("candidateStepWriter")});
        await recordUpdateRunStepAsync(run.runId,{step:'warm-compensation-worker',status:'completed'},{env:run.env});
        let resume;
        const interrupted = new Promise(resolve=>{resume=resolve;});
        let releaseObservation;
        const observation = new Promise(resolve=>{releaseObservation=resolve;});
        // This gate proves snapshot ordering only. Release it at dispatch, not receipt settlement.
        const unregisterObservation = registerSignalExitGate(observation,()=>{
          marker('compensation-signal-snapshot');
          resume();
        });
        let writer;
        let receiptWorker;
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function(request,...args) {
          const result = Reflect.apply(post,this,[request,...args]);
          if(request.type==='execute' && deserialize(request.input).type==='updateRuns.recordPhase') {
            Worker.prototype.postMessage=post;
            receiptWorker=this;
            assert.equal(fs.existsSync(root+'/compensation-signal-snapshot'),true);
            marker('compensation-phase-dispatched');
            process.send({compensationReceipt:true});
            releaseObservation();
            unregisterObservation();
          }
          return result;
        };
        process.once('message',()=>{
          if(mode==='uncertain-compensation') {
            receiptWorker.once('exit',()=>marker('compensation-writer-retired'));
            receiptWorker.emit('error',new Error('fixture compensation writer transport failure'));
          }
          writer?.exec('ROLLBACK');writer?.close();writer=undefined;
        });
        let rollbackChecked=false;
        const beginReceipt = () => {
          writer=new NativeDatabase(path.join(stateDir,'state','openclaw.sqlite'));
          writer.exec('BEGIN IMMEDIATE');
        };
        const nativeFs = await import('node:fs/promises');
        const originalLstat = nativeFs.default.lstat;
        if(mode==='sealed-compensation') {
          nativeFs.default.lstat = async (...args) => {
            const result=await originalLstat(...args);
            if(String(args[0])===path.join(stateDir,'state')) {
              nativeFs.default.lstat=originalLstat;
              ready();
              await interrupted;
            }
            return result;
          };
        }
        try {
          await finishUpdate({
            root,mutationStarted:true,installKindChanged:false,
            result:{status:'error',mode:'npm',root,reason:'readyz-unhealthy',steps:[],durationMs:1},
            configSnapshot,schemaVersions,requestedChannel:null,storedChannel:'stable',channel:'stable',
            downgradeRisk:false,shouldRestart:false,opts:currentOptions,
            ownedManagedUpdateEnv:run.env,preManagedServiceStop:{...before,stopped:true},
            controlPlaneUpdateSentinelMeta:null,preUpdatePluginInstallRecords:{},startedAt:Date.now(),updateStepTimeoutMs:1000,
            packageTransaction:{
              backupRoot:root+'/retained-package',
              assertRollbackSafe:async()=>{
                marker('compensation-rollback-entered');
                if(!rollbackChecked) {
                  rollbackChecked=true;
                  if(mode!=='sealed-compensation') {ready(); await interrupted;}
                  beginReceipt();
                }
              },
              rollback:async assertCurrent=>{
                assertCurrent();marker('compensation-package-rollback');
                return {name:'package rollback',command:'fixture restore',cwd:root,durationMs:0,exitCode:1,activePackageRoot:root};
              },
              complete:async()=>{},
            },
          });
        } catch(error) {
          if(mode==='uncertain-compensation') {
            assert.equal(hasCommandProcessCleanupError(error),true);
            assert.equal(error.code,'ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN');
            assert.match(inspect(error,{depth:null}),/outcome-unknown/);
            assert.match(inspect(error,{depth:null}),/fixture compensation writer transport failure/);
            assert.equal(fs.existsSync(root+'/compensation-writer-retired'),true);
            marker('compensation-uncertainty-observed');
          } else if(mode==='sealed-compensation') {
            marker('compensation-refusal-observed');
            process.send({compensationRefused:!fs.existsSync(root+'/compensation-rollback-entered')});
          } else {
            marker('compensation-finish-observed');
          }
        } finally {
          nativeFs.default.lstat=originalLstat;
          Worker.prototype.postMessage=post;
          writer?.exec('ROLLBACK');writer?.close();
          releaseObservation();unregisterObservation();
        }
      };
    })();
  `;
}
