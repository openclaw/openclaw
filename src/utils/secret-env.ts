import fs from "node:fs";
import { normalizeOptionalSecretInput } from "./normalize-secret-input.js";

export type SecretEnvValue = {
  value: string;
  source: "env" | "file";
  envVar: string;
};

export function resolveSecretEnvValue(
  envVar: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretEnvValue | null {
  const direct = normalizeOptionalSecretInput(env[envVar]);
  if (direct) {
    return { value: direct, source: "env", envVar };
  }

  const fileVar = `${envVar}_FILE`;
  const filePath = normalizeOptionalSecretInput(env[fileVar]);
  if (!filePath) {
    return null;
  }

  try {
    const fromFile = normalizeOptionalSecretInput(fs.readFileSync(filePath, "utf-8"));
    if (!fromFile) {
      return null;
    }
    return { value: fromFile, source: "file", envVar: fileVar };
  } catch {
    return null;
  }
}
