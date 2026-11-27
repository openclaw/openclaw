export async function createInstallPlanFixture(params?: {
  wrapperPath?: string;
  env?: Record<string, string | undefined>;
}): Promise<{
  programArguments: string[];
  workingDirectory: string;
  environment: Record<string, string | undefined>;
  environmentValueSources?: Record<string, string | undefined>;
}> {
  const environment: Record<string, string | undefined> = {};
  if (params?.wrapperPath || params?.env?.OPENCLAW_WRAPPER) {
    environment.OPENCLAW_WRAPPER = params.wrapperPath ?? params.env?.OPENCLAW_WRAPPER;
  }
  return {
    programArguments: params?.wrapperPath
      ? [params.wrapperPath, "gateway", "run"]
      : ["openclaw", "gateway", "run"],
    workingDirectory: "/tmp",
    environment,
  };
}

export function nodeProbeOutput(nodeVersion: string, sqliteVersion = "3.53.4") {
  return {
    stdout: JSON.stringify({
      nodeVersion,
      sqliteVersion,
      sqliteProbe: { available: true, version: sqliteVersion, text: true, blob: true, json: true },
    }),
    stderr: "",
  };
}
