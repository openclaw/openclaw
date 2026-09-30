import path from "node:path";
import { resolveNewStateDir } from "../../../config/state-dir.js";
import { resolveRequiredHomeDir } from "../../../infra/home-dir.js";
import { resolveEnvironmentValue } from "../../../infra/process-env.js";

/** Service scratch can outlive the shell environment that originally selected it. */
export async function inspectDoctorTemporaryDirectories(env: NodeJS.ProcessEnv): Promise<{
  directories: string[];
  warnings: string[];
}> {
  const keys = ["TMPDIR", "TMP", "TEMP"];
  const directories = keys
    .map((key) => resolveEnvironmentValue(env, key))
    .filter((directory): directory is string => Boolean(directory?.trim()));
  directories.push(
    path.join(
      resolveNewStateDir(() => resolveRequiredHomeDir(env)),
      "tmp",
    ),
  );
  const warnings: string[] = [];
  try {
    const { resolveGatewayService } = await import("../../../daemon/service.js");
    const command = await resolveGatewayService().readCommand(env, {
      requireLoaded: true,
      timeoutMs: 5_000,
    });
    const paths = process.platform === "win32" ? path.win32 : path;
    const absolute = (value: string) =>
      paths.isAbsolute(value) &&
      (process.platform !== "win32" || paths.parse(value).root.length > 1);
    for (const definition of [command, command?.managedDefinition]) {
      for (const key of keys) {
        const directory = resolveEnvironmentValue(definition?.environment, key);
        if (!directory?.trim()) {
          continue;
        }
        const workingDirectory = definition?.workingDirectory;
        const drive = paths
          .parse(directory)
          .root.replace(/[\\/]+$/u, "")
          .toLowerCase();
        if (absolute(directory)) {
          directories.push(directory);
        } else if (
          workingDirectory &&
          absolute(workingDirectory) &&
          (!drive || paths.parse(workingDirectory).root.toLowerCase().startsWith(drive))
        ) {
          directories.push(paths.resolve(workingDirectory, directory));
        } else {
          warnings.push(
            `The managed service records a relative ${key} without an absolute working directory; its temporary artifacts could not be inspected.`,
          );
        }
      }
    }
  } catch (error) {
    warnings.push(`Could not inspect the managed service temporary directory: ${String(error)}`);
  }
  return { directories, warnings };
}
