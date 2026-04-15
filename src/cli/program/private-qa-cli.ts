export function isPrivateQaCliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
}

function isModuleNotFoundError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";
}

export function loadPrivateQaCliModule(): Promise<Record<string, unknown>> {
  return (async () => {
    const specifiers = [
      "../../plugin-sdk/qa-lab.js",
      "./plugin-sdk/qa-lab.js",
      "../../../dist/plugin-sdk/qa-lab.js",
    ] as const;

    let lastNotFoundError: unknown;
    for (const specifier of specifiers) {
      try {
        return (await import(specifier)) as Record<string, unknown>;
      } catch (err) {
        if (isModuleNotFoundError(err)) {
          lastNotFoundError = err;
          continue;
        }
        throw err;
      }
    }

    throw (
      lastNotFoundError ??
      new Error("Unable to resolve the private QA CLI module from any known runtime location.")
    );
  })();
}
