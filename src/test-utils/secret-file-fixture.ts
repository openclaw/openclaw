// Creates secret-file fixtures for config and credential tests.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "./temp-dir.js";

type SecretFiles = {
  passwordFile?: string;
  tokenFile?: string;
};

/** Writes temporary secret files for config tests and removes the directory afterward. */
export async function withTempSecretFiles<T>(
  prefix: string,
  secrets: { password?: string; token?: string },
  run: (files: SecretFiles) => Promise<T>,
): Promise<T> {
  return withTempDir(prefix, async (dir) => {
    const files: SecretFiles = {};
    if (secrets.token !== undefined) {
      files.tokenFile = path.join(dir, "token.txt");
      await fs.writeFile(files.tokenFile, secrets.token, "utf8");
    }
    if (secrets.password !== undefined) {
      files.passwordFile = path.join(dir, "password.txt");
      await fs.writeFile(files.passwordFile, secrets.password, "utf8");
    }
    return await run(files);
  });
}
