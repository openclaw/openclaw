import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

it("records binary fixture dependencies and selects the same failure as the full oracle", async () => {
  const root = tempDirs.make("vitest-declared-inputs-");
  const probe = path.join(root, "probe.mjs");
  const plugin = pathToFileURL(path.join(repoRoot, "test/vitest/vitest.declared-inputs.ts")).href;
  fs.symlinkSync(
    fs.realpathSync(path.join(repoRoot, "node_modules")),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  fs.writeFileSync(
    probe,
    `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createVitest } from "vitest/node";
const root = ${JSON.stringify(root)};
const write = (file, data) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, data);
};
write("package.json", '{"type":"module"}');
const owner = "src/hooks/install.test.ts";
const input = "test/fixtures/hooks-install/tar-evil-id.tar";
write(input, Buffer.from([0,255,17]));
write(owner, 'import fs from "node:fs"; import {test,expect} from "vitest"; test("binary input",()=>expect([...fs.readFileSync("test/fixtures/hooks-install/tar-evil-id.tar")]).toEqual([0,255,17]));');
write("src/unrelated.test.ts", 'import {test,expect} from "vitest"; test("control",()=>expect(2+2).toBe(4));');
write("vitest.config.ts", 'import {createVitestDeclaredInputsPlugin} from '+${JSON.stringify(JSON.stringify(plugin))}+'; export default {plugins:process.env.DECLARED_INPUTS==="1"?[createVitestDeclaredInputsPlugin(process.cwd())]:[],cacheDir:".cache/vite",test:{include:["src/**/*.test.ts"],pool:"forks",maxWorkers:1,experimental:{recordDependencies:true}}};');
const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
function run(name, declared, filters=[], expected=0) {
  const result = spawnSync(process.execPath, [cli,"run",...filters,"--reporter=json","--outputFile="+name+".json"], {cwd:root,env:{...process.env,DECLARED_INPUTS:declared?"1":"0"},encoding:"utf8",timeout:20000,maxBuffer:1024*1024});
  assert.equal(result.status, expected, result.stderr+result.stdout);
  return JSON.parse(fs.readFileSync(name+".json","utf8"));
}
async function selected(declared) {
  process.env.DECLARED_INPUTS = declared ? "1" : "0";
  const ctx = await createVitest({root,config:path.join(root,"vitest.config.ts"),watch:false,related:[path.join(root,input)]});
  try { return (await ctx.getRelevantTestSpecifications()).map(s=>path.relative(root,s.moduleId).split(path.sep).join("/")).sort(); }
  finally { await ctx.close(); }
}
assert.equal(run("native",false).numPassedTests,2);
write(input,Buffer.from([1]));
assert.deepEqual(await selected(false),[]);
write(input,Buffer.from([0,255,17]));
fs.rmSync(".cache",{recursive:true,force:true});
assert.equal(run("declared",true).numPassedTests,2);
write(input,Buffer.from([1]));
assert.deepEqual(await selected(true),[owner]);
const failures = report => report.testResults.filter(r=>r.status==="failed").map(r=>path.relative(root,r.name).split(path.sep).join("/")).sort();
assert.deepEqual(failures(run("selected",true,[owner],1)),[owner]);
assert.deepEqual(failures(run("oracle",true,[],1)),[owner]);
`,
  );
  const result = await runNodeScript(probe, { ...process.env, NODE_OPTIONS: "" }, 45_000, {
    cwd: root,
    executable: process.execPath,
    maxBuffer: 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
}, 50_000);
