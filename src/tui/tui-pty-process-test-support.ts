import path from "node:path";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

function buildTuiCliScript(
  args: string[],
  tuiCliModuleUrl: string,
  nativeProcessOwner?: { anchorUrl: string; lineageUrl: string },
) {
  const ownerBinding =
    nativeProcessOwner === undefined
      ? []
      : [
          `import { bindInheritedNativeProcessOwner } from ${JSON.stringify(nativeProcessOwner.lineageUrl)};`,
          `const releaseNativeOwner = bindInheritedNativeProcessOwner(${JSON.stringify(nativeProcessOwner.anchorUrl)});`,
        ];
  return [
    ...ownerBinding,
    `import { Command } from "commander";`,
    `import { registerTuiCli } from ${JSON.stringify(tuiCliModuleUrl)};`,
    `const program = new Command();`,
    `program.exitOverride();`,
    `registerTuiCli(program);`,
    `program.parseAsync([process.execPath, "openclaw", ...${JSON.stringify(args)}], { from: "node" })${nativeProcessOwner === undefined ? "" : ".finally(releaseNativeOwner)"}.catch((error) => {`,
    `  console.error(error);`,
    `  process.exit(1);`,
    `});`,
  ].join("\n");
}

export async function buildTuiProcessArgs(
  args: string[],
  options: { nativeProcessOwner?: string } = {},
) {
  // Explicit fixture anchors must bind the same module graph as the real TUI CLI.
  if (
    process.env.OPENCLAW_TUI_PTY_USE_BUILT_CLI === "1" &&
    options.nativeProcessOwner === undefined
  ) {
    return [path.join(process.cwd(), "openclaw.mjs"), ...args];
  }
  const { tuiPtyRuntimeEntrypoints } = await import("./tui-pty-runtime-test-support.js");
  const tuiUrl = resolveRuntimeWorkerUrl(tuiPtyRuntimeEntrypoints.cli);
  return [
    ...resolveRuntimeWorkerArgv(tuiUrl).slice(0, -1),
    "--input-type=module",
    "--eval",
    buildTuiCliScript(
      args,
      tuiUrl.href,
      options.nativeProcessOwner === undefined
        ? undefined
        : {
            anchorUrl: options.nativeProcessOwner,
            lineageUrl: resolveRuntimeWorkerUrl(tuiPtyRuntimeEntrypoints.processLineage).href,
          },
    ),
  ];
}
