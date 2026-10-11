// Handles fast version output before the full CLI graph loads.
import { isRootVersionInvocation } from "./cli/argv.js";
import { resolveCliContainerTarget } from "./cli/container-target.js";

export function tryHandleRootVersionFastPath(argv: string[]): boolean {
  if (resolveCliContainerTarget(argv)) {
    return false;
  }
  if (!isRootVersionInvocation(argv)) {
    return false;
  }
  const onError = async (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const message = `[openclaw] Failed to resolve version: ${detail}\n`;
    try {
      const [{ loadCliDotEnv }, { formatConsoleDiagnosticBlock }] = await Promise.all([
        import("./cli/dotenv.js"),
        import("./logging/json-console-line.js"),
      ]);
      loadCliDotEnv({ quiet: true });
      process.stderr.write(formatConsoleDiagnosticBlock({ level: "error", message }));
    } catch {
      process.stderr.write(message);
    } finally {
      process.exit(1);
    }
  };

  Promise.all([import("./version.js"), import("./infra/git-commit.js")])
    .then(([{ VERSION }, { resolveCommitHash }]) => {
      const commit = resolveCommitHash({ moduleUrl: import.meta.url });
      console.log(commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`);
      process.exit(0);
    })
    .catch(onError);
  return true;
}
