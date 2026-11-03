import type {
  GatewayServiceCommandSnapshot,
  GatewayServiceEnvironmentValueSource,
} from "./service-types.js";
import {
  resolveSystemdEnvironmentFiles,
  type SystemdEnvironmentFilesParams,
} from "./systemd-environment-files.js";

type SystemdCommandSnapshotParams = SystemdEnvironmentFilesParams & {
  programArguments: string[];
  workingDirectory: string;
  inlineEnvironment: Record<string, string>;
  unsetEnvironment: string[];
};

export async function buildSystemdCommandSnapshot(
  params: SystemdCommandSnapshotParams,
): Promise<GatewayServiceCommandSnapshot> {
  const fileEnvironment = await resolveSystemdEnvironmentFiles(params);
  const environment = { ...params.inlineEnvironment, ...fileEnvironment };
  const environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource> =
    Object.fromEntries(Object.keys(params.inlineEnvironment).map((key) => [key, "inline"]));
  for (const key of Object.keys(fileEnvironment)) {
    environmentValueSources[key] = Object.hasOwn(params.inlineEnvironment, key)
      ? "inline-and-file"
      : "file";
  }
  for (const assignment of params.unsetEnvironment) {
    const separator = assignment.indexOf("=");
    const key = separator < 0 ? assignment : assignment.slice(0, separator);
    if (separator < 0 || environment[key] === assignment.slice(separator + 1)) {
      delete environment[key];
      delete environmentValueSources[key];
    }
  }
  return {
    programArguments: params.programArguments,
    ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
    ...(Object.keys(environment).length > 0 ? { environment, environmentValueSources } : {}),
  };
}
