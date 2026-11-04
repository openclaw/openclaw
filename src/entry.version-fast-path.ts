// Handles fast version output before the full CLI graph loads.
import { formatErrorStackWithMessage } from "@openclaw/normalization-core/error-coercion";
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
    const detail = error instanceof Error ? formatErrorStackWithMessage(error) : String(error);
    const message = `[openclaw] Failed to resolve version: ${detail}\n`;
    try {
      const [{ loadCliDotEnv }, { formatConsoleDiagnosticBlock }] = await Promise.all([
        import("./cli/dotenv.js"),
        import("./logging/json-console-line.js"),
      ]);
      loadCliDotEnv();
      process.stderr.write(formatConsoleDiagnosticBlock({ message }));
    } catch {
      process.stderr.write(message);
    } finally {
      process.exitCode = 1;
    }
  };

  Promise.all([
    import("./version.js"),
    import("./infra/git-commit.js"),
    import("./cli/version-output.js"),
  ])
    .then(([{ VERSION }, { resolveCommitHash }, { formatRootVersionOutput }]) => {
      const commit = resolveCommitHash({ moduleUrl: import.meta.url });
      console.log(formatRootVersionOutput(argv, VERSION, commit));
      process.exitCode = 0;
    })
    .catch(onError);
  return true;
}
