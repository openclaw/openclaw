import path from "node:path";
import { resolveNewStateDir } from "../../../config/state-dir.js";
import { resolveRequiredHomeDir } from "../../../infra/home-dir.js";

/** Service scratch can outlive the shell environment that originally selected it. */
export async function inspectDoctorTemporaryDirectories(env: NodeJS.ProcessEnv): Promise<{
  directories: string[];
  warnings: string[];
}> {
  const directories = [env.TMPDIR, env.TMP, env.TEMP].filter((directory): directory is string =>
    Boolean(directory?.trim()),
  );
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
    for (const definition of [command, command?.managedDefinition]) {
      const directory = definition?.environment?.TMPDIR;
      if (directory?.trim()) {
        if (path.isAbsolute(directory)) {
          directories.push(directory);
        } else if (definition?.workingDirectory) {
          directories.push(path.resolve(definition.workingDirectory, directory));
        } else {
          warnings.push(
            "The managed service records a relative TMPDIR without a working directory; its temporary artifacts could not be inspected.",
          );
        }
      }
    }
  } catch (error) {
    warnings.push(`Could not inspect the managed service temporary directory: ${String(error)}`);
  }
  return { directories, warnings };
}
