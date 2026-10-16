import nodeProcess from "node:process";
import { exit as terminate, reallyExit as terminateImmediately } from "node:process";
import * as processNamespace from "process";
import { default as defaultProcess } from "process";

process.exit(1);
process.reallyExit(1);
process["exit"](1);
process[`exit`](1);
process?.exit?.(1);
(process as NodeJS.Process).exit(1);
(process satisfies NodeJS.Process).exit(1);
process.exit!.call(process, 1);
nodeProcess.exit(1);
processNamespace.reallyExit(1);
defaultProcess.exit(1);
globalThis.process.exit(1);
global["process"]["reallyExit"](1);
const alias = nodeProcess;
const anotherAlias = alias;
anotherAlias.exit(1);
const { process: globalProcess } = globalThis;
globalProcess.exit(1);
const { exit: callback, reallyExit } = process;
const saved = process.exit;
const bound = process.exit.bind(process);
setTimeout(process.exit, 0);
(await import("node:process")).exit(1);
const { default: dynamicProcess } = await import("process");
dynamicProcess.exit(1);
const { default: namespaceDefault } = processNamespace;
namespaceDefault.reallyExit(1);
terminate(1);
terminateImmediately(1);

// Safe examples must not be reported, including shadowed globals and imports.
process.exitCode = 1;
nodeProcess.exitCode = 1;
process.on("exit", () => {});
const text = "process.exit(1)";
const template = `process.reallyExit(1)`;
// process.exit(1);
const other = { exit() {} };
other.exit();
function localProcess(process: { exit(): void }) {
  process.exit();
}
function localImport(nodeProcess: { exit(): void }) {
  nodeProcess.exit();
}
function localGlobal(globalThis: { process: { exit(): void } }) {
  globalThis.process.exit();
}
{
  const alias = other;
  alias.exit();
}
let reassigned = process;
reassigned = other;
reassigned.exit();
const cycleA = cycleB;
const cycleB = cycleA;
cycleA.exit();
