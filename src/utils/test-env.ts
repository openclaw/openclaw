import { parseBooleanValue } from "./boolean.js";

export function isTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" || parseBooleanValue(env.VITEST) === true;
}
