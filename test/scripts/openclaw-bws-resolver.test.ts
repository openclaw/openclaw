// Bitwarden resolver tests cover exec passEnv forwarding and resolver-to-bws env handoff.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSecretRefString } from "../../src/secrets/resolve.js";

const resolverPath = fileURLToPath(
  new URL("../../scripts/secrets/openclaw-bws-resolver.mjs", import.meta.url),
);

const SECRET_ID = "openclaw/providers/openai/apiKey";

/** Writes a fake `bws` CLI that records the env it received and emits one secret. */
function writeFakeBws(dir: string, capturePath: string): string {
  const bwsPath = path.join(dir, "fake-bws");
  const script = `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(capturePath)}, \`bws child saw BWS_SERVER_URL=\${process.env.BWS_SERVER_URL ?? "(unset)"}\\n\`);
process.stdout.write(JSON.stringify([{ key: ${JSON.stringify(SECRET_ID)}, value: "sk-test-value" }]) + "\\n");
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
      const capturePath = path.join(dir, "captured-env.txt");
      const bwsBin = writeFakeBws(dir, capturePath);
      const stdout = runResolver({
        PATH: process.env.PATH ?? "",
        BWS_ACCESS_TOKEN: "token",
        BWS_BIN: bwsBin,
        BWS_SERVER_URL: "https://pass.example.com",
      });

      const captured = fs.readFileSync(capturePath, "utf8");
      expect(captured).toBe("bws child saw BWS_SERVER_URL=https://pass.example.com\n");

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
      const capturePath = path.join(dir, "captured-env.txt");
      const bwsBin = writeFakeBws(dir, capturePath);
      runResolver({
        PATH: process.env.PATH ?? "",
        BWS_ACCESS_TOKEN: "token",
        BWS_BIN: bwsBin,
      });

      const captured = fs.readFileSync(capturePath, "utf8");
      expect(captured).toBe("bws child saw BWS_SERVER_URL=(unset)\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exec provider passEnv forwards BWS_SERVER_URL through resolver to bws", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bws-exec-chain-"));
    try {
      const capturePath = path.join(dir, "bws-captured-env.txt");
      const bwsBin = writeFakeBws(dir, capturePath);
      const resolverCopy = path.join(dir, "openclaw-bws-resolver.mjs");
      fs.copyFileSync(resolverPath, resolverCopy);
      fs.chmodSync(resolverCopy, 0o700);

      const resolved = await resolveSecretRefString(
        { source: "exec", provider: "bws", id: SECRET_ID },
        {
          config: {
            secrets: {
              providers: {
                bws: {
                  source: "exec",
                  command: resolverCopy,
                  passEnv: ["BWS_ACCESS_TOKEN", "PATH", "BWS_BIN", "BWS_SERVER_URL"],
                  jsonOnly: true,
                  allowInsecurePath: true,
                },
              },
            },
          },
          env: {
            PATH: `${dir}:${process.env.PATH ?? ""}`,
            BWS_ACCESS_TOKEN: "demo-token",
            BWS_BIN: bwsBin,
            BWS_SERVER_URL: "https://pass.example.com",
          },
        },
      );

      expect(resolved).toBe("sk-test-value");
      expect(fs.readFileSync(capturePath, "utf8")).toBe(
        "bws child saw BWS_SERVER_URL=https://pass.example.com\n",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
