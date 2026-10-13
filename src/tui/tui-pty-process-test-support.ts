import path from "node:path";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { tuiPtyRuntimeEntrypoints } from "./tui-pty-runtime-test-support.js";

function buildTuiCliScript(args: string[], tuiCliModuleUrl: string) {
  return [
    `import { Command } from "commander";`,
    `import { registerTuiCli } from ${JSON.stringify(tuiCliModuleUrl)};`,
    `const program = new Command();`,
    `program.exitOverride();`,
    `registerTuiCli(program);`,
    `program.parseAsync([process.execPath, "openclaw", ...${JSON.stringify(args)}], { from: "node" }).catch((error) => {`,
    `  console.error(error);`,
    `  process.exit(1);`,
    `});`,
  ].join("\n");
}

export function buildTuiProcessArgs(args: string[]) {
  if (process.env.OPENCLAW_TUI_PTY_USE_BUILT_CLI === "1") {
    return [path.join(process.cwd(), "openclaw.mjs"), ...args];
  }
  const tuiUrl = resolveRuntimeWorkerUrl(tuiPtyRuntimeEntrypoints.cli);
  return [
    ...resolveRuntimeWorkerArgv(tuiUrl).slice(0, -1),
    "--input-type=module",
    "--eval",
    buildTuiCliScript(args, tuiUrl.href),
  ];
}
