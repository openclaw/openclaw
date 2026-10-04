import path from "node:path";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { triageMaintenanceRuntimeEntrypoints } from "../../infra/triage-runtime.test-support.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

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
      fs.writeFileSync(root + '/package.json', JSON.stringify({name:'openclaw',version:'2026.9.1',type:'module'}));
      fs.writeFileSync(root + '/openclaw.mjs', '// synthetic service entry');
      fs.mkdirSync(stateDir, {recursive:true});
      fs.writeFileSync(configPath, '{}');
      fs.mkdirSync(root + '/dist/infra', {recursive:true});
      fs.writeFileSync(root + '/dist/infra/update-candidate-state.worker.js', ${JSON.stringify(workerSource)});
      const marker = name => fs.writeFileSync(root + '/' + name, 'observed');
      let running = true;
      let receiptRun;
      const serviceUrl = ${JSON.stringify(resolveRuntimeWorkerUrl(triageMaintenanceRuntimeEntrypoints.service).href)};
      const serviceModule = await import(serviceUrl);
      const service = {
        label:'fixture service',loadedText:'loaded',notLoadedText:'not loaded',
        isLoaded:async()=>true, isEnabled:async()=>true,
        readCommand:async()=>({
          programArguments:[process.execPath,root+'/openclaw.mjs','gateway','--port','19101'],
          environment:{HOME:root,OPENCLAW_STATE_DIR:stateDir,OPENCLAW_CONFIG_PATH:configPath},
        }),
        readRuntime:async()=>({status:running?'running':'stopped',pid:running?Math.max(process.pid,process.ppid)+1:undefined,systemd:{managerUid:process.getuid?.()}}),
        stop:async args=>{
          args.assertCurrent?.();
          assert.equal(getUpdateRun(receiptRun.runId,{env:receiptRun.env}).phase,'activating');
          marker('compensation-native-stop');running=false;
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
        const before = await maybeStopManagedServiceBeforeMutableUpdate({root,updateInstallKind:'package',shouldRestart:true,jsonMode:true,phase:'inspect',updateRun:run,timeoutMs:1000});
        assert.equal(before.serviceUpdateVerdict?.kind,'owned',JSON.stringify({
          inspected:before.inspected,runtimeInspected:before.runtimeInspected,
          serviceMutationAllowed:before.serviceMutationAllowed,
          serviceMutationSkipMessage:before.serviceMutationSkipMessage,
          blockMessage:before.blockMessage,serviceUpdateVerdict:before.serviceUpdateVerdict,
        }));
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
