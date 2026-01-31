import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type TalkApiKeyDeps = {
  fs?: typeof fs;
  os?: typeof os;
  path?: typeof path;
};

export function readTalkApiKeyFromProfile(deps: TalkApiKeyDeps = {}): string | null {
  const fsImpl = deps.fs ?? fs;
  const osImpl = deps.os ?? os;
  const pathImpl = deps.path ?? path;

  const home = osImpl.homedir();
  const candidates = [".profile", ".zprofile", ".zshrc", ".bashrc"].map((name) =>
    pathImpl.join(home, name),
  );
  for (const candidate of candidates) {
    if (!fsImpl.existsSync(candidate)) {
      continue;
    }
    try {
      const text = fsImpl.readFileSync(candidate, "utf-8");
      const match = text.match(
        /(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^\n"']+)["']?/,
      );
      const value = match?.[1]?.trim();
      if (value) {
        return value;
      }
    } catch {
      // Ignore profile read errors.
    }
  }
  return null;
}

export function resolveTalkApiKey(
  env: NodeJS.ProcessEnv = process.env,
  deps: TalkApiKeyDeps = {},
): string | null {
  const envValue = (env.ELEVENLABS_API_KEY ?? "").trim();
  if (envValue) {
    return envValue;
  }
  return readTalkApiKeyFromProfile(deps);
}
