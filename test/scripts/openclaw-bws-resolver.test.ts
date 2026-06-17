// Bitwarden resolver script tests cover parent-env forwarding to the bws CLI.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const resolverPath = fileURLToPath(
  new URL("../../scripts/secrets/openclaw-bws-resolver.mjs", import.meta.url),
);

const SECRET_ID = "openclaw/providers/openai/apiKey";

/** Writes a fake `bws` CLI that records the env it received and emits one secret. */
function writeFakeBws(dir: string, capturePath: string): string {
  const bwsPath = path.join(dir, "fake-bws.cjs");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  BWS_SERVER_URL: process.env.BWS_SERVER_URL ?? null,
}));
process.stdout.write(JSON.stringify([{ key: ${JSON.stringify(SECRET_ID)}, value: "sk-test-value" }]));
`;
  fs.writeFileSync(bwsPath, script, { mode: 0o755 });
  return bwsPath;
}

function runResolver(env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [resolverPath], {
    encoding: "utf8",
    input: JSON.stringify({ protocolVersion: 1, ids: [SECRET_ID] }),
    env,
  });
}

describe("openclaw-bws-resolver", () => {
  it("forwards BWS_SERVER_URL to the bws CLI for self-hosted instances", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bws-resolver-"));
    try {
      const capturePath = path.join(dir, "captured-env.json");
      const bwsBin = writeFakeBws(dir, capturePath);
      const stdout = runResolver({
        PATH: process.env.PATH ?? "",
        BWS_ACCESS_TOKEN: "token",
        BWS_BIN: bwsBin,
        BWS_SERVER_URL: "https://pass.example.com",
      });

      const captured = JSON.parse(fs.readFileSync(capturePath, "utf8")) as {
        BWS_SERVER_URL: string | null;
      };
      expect(captured.BWS_SERVER_URL).toBe("https://pass.example.com");

      const response = JSON.parse(stdout) as { values: Record<string, string> };
      expect(response.values[SECRET_ID]).toBe("sk-test-value");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits BWS_SERVER_URL when it is absent from the parent env", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bws-resolver-"));
    try {
      const capturePath = path.join(dir, "captured-env.json");
      const bwsBin = writeFakeBws(dir, capturePath);
      runResolver({
        PATH: process.env.PATH ?? "",
        BWS_ACCESS_TOKEN: "token",
        BWS_BIN: bwsBin,
      });

      const captured = JSON.parse(fs.readFileSync(capturePath, "utf8")) as {
        BWS_SERVER_URL: string | null;
      };
      expect(captured.BWS_SERVER_URL).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
