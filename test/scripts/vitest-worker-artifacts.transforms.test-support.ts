import path from "node:path";
import { pathToFileURL } from "node:url";
import { convertPathToPattern } from "tinyglobby";
import { writeFixture } from "./vitest-worker-artifacts.test-support.js";

/** Exercise the real declaration bridge and cache without rebuilding unrelated workers. */
export function workerTransformProbe(directory: string, layout: "single" | "projects") {
  const root = process.cwd();
  const value = writeFixture(directory, "value.ts", 'export const value: string = "first";');
  const configuredValue = writeFixture(
    directory,
    "configured-value.ts",
    'export const value: string = "configured";',
  );
  const parent = writeFixture(
    directory,
    "parent.ts",
    `
    import {runtimeProcessEntrypoints} from ${JSON.stringify(path.join(root, "src/infra/runtime-process-entrypoints.ts"))};
    export {value} from '#fixture-value';
    export const generation: string = runtimeProcessEntrypoints.sqliteReadOnly.currentModuleUrl;
  `,
  );
  const test = writeFixture(
    directory,
    "child.test.ts",
    `
    import fs from 'node:fs';
    import {it,expect,inject} from 'vitest';
    import {value,generation} from './parent.ts';
    const preparedAtCollection = fs.existsSync(new URL(generation));
    it('executes the transformed parent with its current declaration', () => {
      expect(preparedAtCollection).toBe(true);
      expect(typeof value).toBe('string');
      fs.appendFileSync(${JSON.stringify(path.join(directory, "observations.jsonl"))}, JSON.stringify({value,configValue:inject('configValue')})+'\\n');
      fs.appendFileSync(${JSON.stringify(path.join(directory, "generations.jsonl"))}, JSON.stringify(generation)+'\\n');
    });
  `,
  );
  const transformFiles = [value, configuredValue, parent].map((file) => file.replaceAll("\\", "/"));
  const cacheDirectory = path.join(directory, "cache");
  const cacheConfig = { fsModuleCache: true, fsModuleCachePath: cacheDirectory };
  const shared = pathToFileURL(path.join(root, "test/vitest/vitest.shared.config.ts")).href;
  const config = writeFixture(
    directory,
    "vitest.config.mts",
    `
    import fs from 'node:fs';
    import {sharedVitestConfig as shared} from ${JSON.stringify(shared)};
    const probe = {name:'fixture:transform-counter', transform(code,id) {
      if (${JSON.stringify(transformFiles)}.includes(id)) fs.appendFileSync(${JSON.stringify(path.join(directory, "transforms.jsonl"))},JSON.stringify(id)+'\\n');
    }};
    const project = name => ({extends:false,plugins:[...shared.plugins,probe],resolve:{...shared.resolve,alias:[{find:'#fixture-value',replacement:${JSON.stringify(value)}},...shared.resolve.alias]},test:{name,include:[${JSON.stringify(convertPathToPattern(test))}],pool:'forks',maxWorkers:1,testTimeout:shared.test.testTimeout,...${JSON.stringify(cacheConfig)},provide:{configValue:'first'}}});
    export default async () => ({root:${JSON.stringify(root)},${layout === "single" ? "...project('first')" : `plugins:shared.plugins,test:{...${JSON.stringify(cacheConfig)},projects:[project('first'),project('second')]}`}});
  `,
  );
  return { config, value, configuredValue, parent, cacheDirectory };
}
