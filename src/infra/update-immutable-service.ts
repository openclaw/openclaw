import fs from "node:fs/promises";
import path from "node:path";
import { parseKeyValueOutput } from "../daemon/runtime-parse.js";
import { resolveServiceEntrypoint } from "../daemon/service-layout.js";
import { execSystemctl } from "../daemon/systemd-exec.js";
import {
  readSystemdServiceCommandLocation,
  readSystemdServiceExecStartAsRoot,
} from "../daemon/systemd-service-files.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";

export async function verifyImmutableService(
  service: ImmutableInstallDescriptor["service"],
  root: string,
  generationPath: string,
  runtimePath: string,
): Promise<void> {
  if (service.scope !== "system" || !/^[A-Za-z0-9_.@:-]+\.service$/u.test(service.unit)) {
    throw new Error("Immutable adoption requires an explicit systemd service unit.");
  }
  const env = { OPENCLAW_SYSTEMD_UNIT: service.unit };
  const target = {
    scope: "system" as const,
    unitName: service.unit,
    unitPath: `/etc/systemd/system/${service.unit}`,
  };
  const location = await readSystemdServiceCommandLocation(env, target);
  if (location.kind !== "command" || !location.command.sourcePath) {
    throw new Error("The immutable Gateway systemd service must already be loaded.");
  }
  target.unitPath = location.command.sourcePath;
  const command = await readSystemdServiceExecStartAsRoot(env, target, service.account);
  if (!command || command.reloadPending || command.sourcePath !== target.unitPath) {
    throw new Error("The immutable Gateway service definition could not be verified.");
  }
  const runtime = await execSystemctl(
    [
      "--system",
      "show",
      service.unit,
      "--property=Id,LoadState,ActiveState,DynamicUser,RootDirectory,RootImage",
    ],
    undefined,
    5_000,
  );
  const properties = parseKeyValueOutput(runtime.stdout, "=");
  if (
    runtime.code !== 0 ||
    properties.id !== service.unit ||
    properties.loadstate !== "loaded" ||
    properties.activestate !== "active" ||
    properties.dynamicuser !== "no" ||
    properties.rootdirectory !== "" ||
    properties.rootimage !== ""
  ) {
    throw new Error(
      "Immutable adoption requires a running systemd service with a fixed account and host filesystem paths.",
    );
  }
  const environment = command.environment ?? {};
  if (
    environment.OPENCLAW_STATE_DIR !== service.stateDir ||
    environment.OPENCLAW_CONFIG_PATH !== service.configPath ||
    (environment.OPENCLAW_PROFILE?.trim() || null) !== service.profile ||
    command.programArguments.some((argument) => /^--(?:profile|dev)(?:=|$)/u.test(argument))
  ) {
    throw new Error(
      "Immutable service state, config, and profile must match its effective environment; command-line profile overrides are unsupported.",
    );
  }
  const executable = command.programArguments[0];
  const launcher = path.join(root, "bin", "openclaw-gateway");
  if (executable === launcher) {
    const source = await fs.readFile(launcher, "utf8");
    if (!source.startsWith(`#!${runtimePath}\n`)) {
      throw new Error("The immutable launcher does not use the adopted Node executable.");
    }
    return;
  }
  const entry = resolveServiceEntrypoint(command);
  if (
    !executable ||
    !path.isAbsolute(executable) ||
    (await fs.realpath(executable)) !== runtimePath ||
    !entry ||
    ![
      path.join(generationPath, "dist", "index.js"),
      path.join(root, "current", "dist", "index.js"),
    ].includes(entry) ||
    (await fs.realpath(entry)) !== path.join(generationPath, "dist", "index.js")
  ) {
    throw new Error(
      "The systemd Gateway command must use the adopted Node executable and current immutable generation.",
    );
  }
}
