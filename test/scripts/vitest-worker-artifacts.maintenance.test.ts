import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { verifyVitestWorkerArtifacts } from "../../scripts/lib/vitest-worker-artifacts.mts";
import { vitestMaintenanceBuildEntries } from "../../scripts/lib/vitest-worker-build-entries.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createWorkerArtifactTest, writeFixture } from "./vitest-worker-artifacts.test-support.js";

const root = process.cwd();
const it = createWorkerArtifactTest();

// Windows task autostart has a separate native boundary outside this Unix service fixture.
it.runIf(process.platform !== "win32").for(["source", "compiled"] as const)(
  "intercepts both real maintenance owners through the %s service boundary",
  (mode, { workerArtifacts }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const { node, prepareWorkers } = workerArtifacts.createFixtureCommands();
      const fixture = workerArtifacts.fixtureDirectory();
      const owner = mode === "compiled" ? createVitestWorkerRun() : undefined;
      const urls = Object.fromEntries(
        Object.entries(vitestMaintenanceBuildEntries).map(([entry, source]) => [
          path.basename(entry),
          pathToFileURL(
            owner ? path.join(owner.descriptor.directory, "dist", `${entry}.js`) : source,
          ).href,
        ]),
      );
      try {
        if (owner) {
          const manifest = await prepareWorkers(owner);
          // The real generation, not a toy manifest, must bind each new artifact.
          for (const name of ["service", "doctor", "update"]) {
            const output = `triage-maintenance/${name}.js`;
            expect(manifest.outputs[output]).toBeDefined();
            // Preparation and disposal verify the whole graph. Fault probes use
            // its actual receipt without rehashing unrelated outputs six times.
            const receipt = {
              ...manifest,
              inputs: {},
              outputs: { [output]: manifest.outputs[output]! },
            };
            const file = new URL(urls[name]!);
            const original = fs.readFileSync(file);
            try {
              fs.appendFileSync(file, "\n// altered maintenance output\n");
              await expect(
                verifyVitestWorkerArtifacts(owner.descriptor.directory, receipt),
              ).rejects.toThrow("Compiled subprocess artifact changed");
              fs.unlinkSync(file);
              await expect(
                verifyVitestWorkerArtifacts(owner.descriptor.directory, receipt),
              ).rejects.toThrow("ENOENT");
            } finally {
              fs.writeFileSync(file, original);
            }
          }
        }
        writeFixture(fixture, "dist/index.js", "");
        writeFixture(fixture, "package.json", '{"name":"openclaw","type":"module"}');
        const unexpected = path.join(fixture, "unexpected-native");
        const bin = path.join(fixture, "bin");
        writeFixture(bin, "package.json", '{"type":"commonjs"}');
        for (const command of ["launchctl", "systemctl"]) {
          const sentinel = writeFixture(
            bin,
            command,
            `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(unexpected)},${JSON.stringify(command)});process.exitCode=97;`,
          );
          fs.chmodSync(sentinel, 0o700);
        }
        const probe = writeFixture(
          fixture,
          "maintenance.mjs",
          `
import assert from 'node:assert/strict';
import os from 'node:os';
import {mock} from 'node:test';
import {registerHooks} from 'node:module';
const root=${JSON.stringify(fixture)}, urls=${JSON.stringify(urls)};
const user=os.userInfo();os.userInfo=()=>({...user,homedir:root});
const calls=[], resolved=[];let operation='import',active=true;
const call=name=>calls.push({operation,name});
const actual=await import(urls.service);
const sentinel=new Error('fixture-owned Doctor finish resolver');
const service={
  readCommand:async()=>{call('readCommand');return {programArguments:[process.execPath,root+'/dist/index.js','gateway','run'],environment:{}};},
  isLoaded:async()=>{call('isLoaded');return true;},
  readRuntime:async()=>{call('readRuntime');return {status:active?'running':'stopped'};},
  stop:async()=>{call('stop');active=false;},
  restart:async()=>{throw new Error('unexpected restart');},
};
mock.module(urls.service,{namedExports:{...actual,resolveGatewayService:()=>{
  call('resolveGatewayService');if(operation==='doctor-finish')throw sentinel;return service;
}}});
registerHooks({resolve(s,c,next){const result=next(s,c);if(s===urls.service)resolved.push(result.url);return result;}});
const {beginDoctorMaintenance}=await import(urls.doctor);
const {maybeStopManagedServiceBeforeMutableUpdate}=await import(urls.update);
try {
  operation='update';
  const inspected=await maybeStopManagedServiceBeforeMutableUpdate({root,updateInstallKind:'package',shouldRestart:true,jsonMode:true,phase:'inspect'});
  assert.equal(inspected.running,true);assert.equal(inspected.stopped,false);assert.equal(inspected.serviceUpdateVerdict.kind,'owned');
  operation='doctor-admission';
  const maintenance=await beginDoctorMaintenance({root,options:{repair:true},runtime:{log:()=>{},error:()=>{},exit:()=>{throw Error('unexpected exit')}}});
  assert(maintenance);
  try {
    assert(calls.some(c=>c.operation==='doctor-admission'&&c.name==='stop'));
    operation='doctor-finish';await assert.rejects(maintenance.finish({}),error=>error===sentinel);
  } finally {await maintenance.release();}
  for(const op of ['update','doctor-admission']) for(const name of ['resolveGatewayService','readCommand','isLoaded','readRuntime']) assert(calls.some(c=>c.operation===op&&c.name===name));
  assert(calls.some(c=>c.operation==='doctor-finish'&&c.name==='resolveGatewayService'));
  if (${mode === "compiled"}) {
    assert(resolved.length > 0);
    for (const url of resolved) { const actual=new URL(url);actual.search='';assert.equal(actual.href,urls.service); }
  }
  console.log(JSON.stringify({mode:${JSON.stringify(mode)},calls,resolved}));
} finally {mock.restoreAll();}
`,
        );
        const result = await node(
          [
            ...(mode === "source"
              ? ["--import", pathToFileURL(path.join(root, "scripts/tsx.mjs")).href]
              : []),
            "--experimental-test-module-mocks",
            probe,
          ],
          fixture,
          {
            ...process.env,
            HOME: fixture,
            USERPROFILE: fixture,
            OPENCLAW_HOME: "",
            OPENCLAW_PROFILE: "default",
            OPENCLAW_STATE_DIR: path.join(fixture, ".openclaw"),
            OPENCLAW_CONFIG_PATH: path.join(fixture, ".openclaw/openclaw.json"),
            OPENCLAW_SUPERVISOR_MODE: "",
            OPENCLAW_SERVICE_REPAIR_POLICY: "auto",
            OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
            OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META: undefined,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            NODE_OPTIONS: "",
          },
        );
        console.log(result.stdout);
        expect(result.code, result.stderr + result.stdout).toBe(0);
        expect(fs.existsSync(unexpected)).toBe(false);
      } finally {
        await owner?.dispose();
      }
      if (owner) {
        expect(fs.existsSync(owner.descriptor.directory)).toBe(false);
      }
    }),
);
