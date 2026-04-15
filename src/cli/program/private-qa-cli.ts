export function isPrivateQaCliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
}

export function loadPrivateQaCliModule(): Promise<Record<string, unknown>> {
  const specifier = ["../../plugin-sdk/", "qa", "-lab.js"].join("");
  return import(specifier) as Promise<Record<string, unknown>>;
}
