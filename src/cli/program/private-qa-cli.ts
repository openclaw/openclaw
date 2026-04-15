export function isPrivateQaCliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
}

export function loadPrivateQaCliModule(): Promise<Record<string, unknown>> {
  return import("../../plugin-sdk/qa-lab.js") as Promise<Record<string, unknown>>;
}
