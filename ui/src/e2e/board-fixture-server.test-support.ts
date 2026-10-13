import { spawn, type ChildProcessByStdio } from "node:child_process";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
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
  output: () => string;
};

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export async function startFixtureServer(
  fixture?: "attachments" | "workboard",
): Promise<FixtureServer> {
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}/__fixtures/board/`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/control-ui-mock-dev.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      ...(fixture ? ["--fixture", fixture] : []),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Retain startup children too, so a hook timeout still reaches their cleanup.
  fixtureProcesses.add(child);
  child.once("close", () => fixtureProcesses.delete(child));
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const mockServer = { child, url, output: () => output };

  try {
    // The CLI publishes this only after listen; cold imports are not readiness failures.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.stdout.off("data", onOutput);
        child.off("close", onClose);
        child.off("error", onError);
      };
      const onOutput = () => {
        if (output.includes(`[control-ui-mock] board fixture: ${url}`)) {
          cleanup();
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`Control UI mock server exited before startup\n${output}`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      child.stdout.on("data", onOutput);
      child.once("close", onClose);
      child.once("error", onError);
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
