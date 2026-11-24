import path from "node:path";
import {
  readDaemonRuntimePinForInstall,
  withDaemonRuntimePinMigration,
} from "../daemon/runtime-pin-state.js";
import {
  gatewayServiceCommandMatchesRoot,
  resolveServiceEntrypointIndex,
} from "../daemon/service-layout.js";
import { reconcileGatewayServiceDefinition } from "../daemon/service-reconciliation.js";
import { resolveManagedGatewayServiceCommand } from "../daemon/service-types.js";
import { resolveGatewayService } from "../daemon/service.js";
import { createNullWriter } from "../shared/null-writer.js";

/** Rebind the next service start once, without stopping the serving Gateway. */
export async function stageReleaseService(params: {
  runningRoot: string;
  launcher: string;
  env: NodeJS.ProcessEnv;
  warn: (message: string) => void;
}): Promise<void> {
  const service = resolveGatewayService();
  if ((await service.hasInstalledDefinition?.({ env: params.env })) === false) {
    return;
  }
  const command = await service.readCommand(params.env, { requireEffective: true });
  if (!command || (await gatewayServiceCommandMatchesRoot(params.runningRoot, command)) !== true) {
    return;
  }
  // System-owned definitions keep their existing entries, which forward to the launcher.
  const source = command.sourcePath?.replaceAll("\\", "/");
  if (
    source?.startsWith("/Library/LaunchDaemons/") ||
    source?.startsWith("/etc/systemd/") ||
    source?.startsWith("/usr/lib/systemd/") ||
    source?.startsWith("/lib/systemd/")
  ) {
    return;
  }
  const managed = resolveManagedGatewayServiceCommand(command)!;
  const entry = resolveServiceEntrypointIndex(managed.programArguments);
  if (entry === undefined) {
    throw new Error("The managed Gateway entrypoint could not be inspected.");
  }
  if (path.resolve(managed.programArguments[entry]!) === params.launcher) {
    return;
  }
  const pin = await withDaemonRuntimePinMigration(params.env, () =>
    readDaemonRuntimePinForInstall({ kind: "gateway", env: params.env }, command, false),
  );
  const programArguments = [...managed.programArguments];
  programArguments[entry] = params.launcher;
  const expectedCommand = { ...managed, programArguments };
  await reconcileGatewayServiceDefinition({
    env: params.env,
    root: params.runningRoot,
    command,
    expectedCommand,
    warn: params.warn,
    install: async (definitionTransaction) => {
      await service.stage({
        ...expectedCommand,
        env: params.env,
        stdout: createNullWriter(),
        preserveAutoStart: true,
        runtimePinUpdate: { expected: pin, pin: pin.pin, requireDefinitionMatch: true },
        definitionTransaction,
        warn: params.warn,
      });
    },
  });
}
