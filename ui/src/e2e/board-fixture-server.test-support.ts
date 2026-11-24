import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { getFreePort } from "../../../src/test-utils/ports.js";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;
const fixtureProcesses = new Set<FixtureProcess>();

afterAll(async () => {
  await Promise.all([...fixtureProcesses].map((child) => stopChildProcess(child, 5_000)));
});

export type FixtureServer = {
  child: FixtureProcess;
  url: string;
};

export async function startFixtureServer(
  fixture?: "attachments" | "workboard",
): Promise<FixtureServer> {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}/__fixtures/board/`;
  const args = ["--import", "./scripts/tsx.mjs", "scripts/control-ui-mock-dev.ts"];
  args.push("--host", "127.0.0.1", "--port", String(port));
  if (fixture) {
    args.push("--fixture", fixture);
  }
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Retain startup children too, so a hook timeout still reaches their cleanup.
  fixtureProcesses.add(child);
  child.once("close", () => fixtureProcesses.delete(child));
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      output += chunk;
    });
  }
  const mockServer = { child, url };

  try {
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        child.stdout.off("data", onOutput);
        child.off("close", onClose);
        child.off("error", settle);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onOutput = () => {
        if (output.includes(`[control-ui-mock] board fixture: ${url}`)) {
          settle();
        }
      };
      const onClose = () =>
        settle(new Error(`Control UI mock server exited before startup\n${output}`));
      child.stdout.on("data", onOutput);
      child.once("close", onClose);
      child.once("error", settle);
    });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Control UI mock server returned ${response.status}\n${output}`);
    }
    return mockServer;
  } catch (error) {
    await stopFixtureServer(mockServer);
    throw error;
  }
}

export async function stopFixtureServer(server: FixtureServer | undefined): Promise<void> {
  if (server) {
    await stopChildProcess(server.child, 5_000);
  }
}
