import {
  isStandaloneRuntimeExecutable,
  resolveOpenClawCliInvocation,
} from "../../cli-invocation.mjs";
import { formatCliCommand } from "../cli/command-format.js";
import { isBunRuntime, isNodeRuntime } from "../daemon/runtime-binary.js";
import { resolveRuntimeArgs } from "./runtime-worker-url.js";
import type { UpdateChannel } from "./update-channels.js";

export function resolveUpdateCliArgv(params: {
  timeoutMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  acceptCapabilities?: boolean;
  fullIntegrityCheck?: boolean;
  admission?: "auto" | "installed";
  reapplyLocalOverrides?: boolean;
  execPath?: string;
  argv1?: string;
}): string[] {
  return resolveManagedServiceCliArgv(params, [
    "update",
    "--yes",
    "--json",
    ...(params.reapplyLocalOverrides ? ["--reapply-local-overrides"] : []),
    ...(params.acceptCapabilities ? ["--accept-capabilities"] : []),
    ...(params.fullIntegrityCheck ? ["--full-integrity-check"] : []),
    ...(params.admission ? ["--admission", params.admission] : []),
    ...(params.channel ? ["--channel", params.channel] : []),
    ...(params.tag ? ["--tag", params.tag] : []),
    ...(typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? ["--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1000)))]
      : []),
  ]);
}

export function resolveManagedServiceCliArgv(
  params: { execPath?: string; argv1?: string },
  args: string[],
): string[] {
  const execPath = params.execPath?.trim();
  const argv1 = execPath ? params.argv1?.trim() : undefined;
  const command =
    execPath &&
    (argv1 ||
      isStandaloneRuntimeExecutable(execPath) ||
      (!isNodeRuntime(execPath) && !isBunRuntime(execPath)))
      ? execPath
      : "openclaw";
  const invocation = resolveOpenClawCliInvocation({
    execPath: command,
    entryPath: argv1 || null,
    execArgv: argv1 ? resolveRuntimeArgs(command) : [],
    args,
  });
  return [invocation.command, ...invocation.args];
}

export function formatManagedServiceUpdateCommand(
  params?: Omit<Parameters<typeof resolveUpdateCliArgv>[0], "execPath" | "argv1">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return formatCliCommand(
    resolveUpdateCliArgv(params ?? {})
      .toSpliced(3, 1)
      .join(" "),
    env,
  );
}

export function buildManagedServiceHandoffUnavailableMessage(command: string): string {
  return [
    "OpenClaw updates cannot safely run inside the live gateway process without a managed-service handoff.",
    `Stop the foreground Gateway, run \`${command}\` from a shell, then launch the Gateway again. For a managed deployment, use its host's stop, update, and restart workflow.`,
  ].join("\n");
}
