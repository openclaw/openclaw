import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWalkthroughStep, SpecPacket, TaskPacket } from "./types.js";

const HEALTHCHECK_TIMEOUT_MS = 60_000;

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function resetGeneratedArtifacts(artifactDir: string) {
  await Promise.all(
    ["before.png", "after.png", "annotated.png", "walkthrough.webm", "serve.log", "review.md"].map(
      (name) => fs.rm(path.join(artifactDir, name), { force: true }),
    ),
  );
}

function spawnShell(command: string, cwd: string) {
  return spawn("zsh", ["-c", command], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealthcheck(url: string, timeoutMs = HEALTHCHECK_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for healthcheck: ${url}`);
}

async function runAgentBrowser(session: string, args: string[]) {
  const command = ["agent-browser", "--session", session, ...args];
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    new Promise<number | null>((resolve) => child.once("close", resolve)),
  ]);
  if ((exitCode ?? 1) !== 0) {
    throw new Error(`agent-browser ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout.trim();
}

async function cleanupAgentBrowserSession(session: string) {
  const runtimeDir = path.join(os.homedir(), ".agent-browser");
  const pidPath = path.join(runtimeDir, `${session}.pid`);
  const socketPath = path.join(runtimeDir, `${session}.sock`);
  const pidRaw = await fs.readFile(pidPath, "utf8").catch(() => null);
  const pid = Number.parseInt(pidRaw?.trim() ?? "", 10);
  if (Number.isFinite(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await Promise.all([fs.rm(pidPath, { force: true }), fs.rm(socketPath, { force: true })]);
}

function readStream(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function assertNever(value: never): never {
  throw new Error(`Unsupported walkthrough action: ${String(value)}`);
}

async function writeServeLog(
  processHandle: { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream },
  logPath: string,
) {
  const chunks: Buffer[] = [];
  const collect = (chunk: Buffer) => {
    chunks.push(Buffer.from(chunk));
  };
  processHandle.stdout.on("data", collect);
  processHandle.stderr.on("data", collect);
  return async () => {
    await fs.writeFile(logPath, Buffer.concat(chunks));
  };
}

async function executeWalkthroughSteps(
  session: string,
  steps: BrowserWalkthroughStep[],
  artifactDir: string,
) {
  for (const step of steps) {
    switch (step.action) {
      case "open":
        if (!step.value) {
          throw new Error("open step requires value");
        }
        await runAgentBrowser(session, ["open", step.value]);
        break;
      case "wait_load":
        await runAgentBrowser(session, ["wait", "--load", step.value ?? "networkidle"]);
        break;
      case "wait_for":
        if (!step.target) {
          throw new Error("wait_for step requires target");
        }
        await runAgentBrowser(session, ["wait", step.target]);
        break;
      case "click":
        if (!step.target) {
          throw new Error("click step requires target");
        }
        await runAgentBrowser(session, ["click", step.target]);
        break;
      case "fill":
        if (!step.target || step.value === undefined) {
          throw new Error("fill step requires target and value");
        }
        await runAgentBrowser(session, ["fill", step.target, step.value]);
        break;
      case "type":
        if (!step.target || step.value === undefined) {
          throw new Error("type step requires target and value");
        }
        await runAgentBrowser(session, ["type", step.target, step.value]);
        break;
      case "press":
        if (!step.value) {
          throw new Error("press step requires value");
        }
        await runAgentBrowser(session, ["press", step.value]);
        break;
      case "scroll":
        await runAgentBrowser(session, ["scroll", step.value ?? "down", step.target ?? "400"]);
        break;
      case "screenshot": {
        const outputPath = step.path
          ? path.join(artifactDir, step.path)
          : path.join(artifactDir, `step-${Date.now()}.png`);
        const args = ["screenshot", outputPath];
        if (step.fullPage) {
          args.splice(1, 0, "--full");
        }
        if (step.annotate) {
          args.splice(1, 0, "--annotate");
        }
        await runAgentBrowser(session, args);
        break;
      }
      case "assert_text": {
        if (!step.target || step.value === undefined) {
          throw new Error("assert_text step requires target and value");
        }
        const text = await runAgentBrowser(session, ["get", "text", step.target]);
        if (!text.includes(step.value)) {
          throw new Error(`Expected "${step.value}" in ${step.target}, got: ${text}`);
        }
        break;
      }
      case "pause":
        await new Promise((resolve) => setTimeout(resolve, step.waitMs ?? 1000));
        break;
      default:
        assertNever(step.action);
    }
    if (step.waitMs) {
      await new Promise((resolve) => setTimeout(resolve, step.waitMs));
    }
  }
}

export async function runArtifactWalkthrough(input: {
  artifactDir: string;
  sessionName: string;
  packet: SpecPacket | TaskPacket;
}) {
  await ensureDir(input.artifactDir);
  await resetGeneratedArtifacts(input.artifactDir);
  await cleanupAgentBrowserSession(input.sessionName);
  const serveLogPath = path.join(input.artifactDir, "serve.log");
  const server = spawnShell(input.packet.startupCommand, input.packet.repoCwd);
  const flushServeLog = await writeServeLog(server, serveLogPath);
  try {
    await waitForHealthcheck(input.packet.healthcheckUrl);
    await runAgentBrowser(input.sessionName, ["open", input.packet.healthcheckUrl]);
    await runAgentBrowser(input.sessionName, [
      "screenshot",
      path.join(input.artifactDir, "before.png"),
    ]);
    await runAgentBrowser(input.sessionName, [
      "record",
      "start",
      path.join(input.artifactDir, "walkthrough.webm"),
    ]);
    await executeWalkthroughSteps(
      input.sessionName,
      input.packet.browserWalkthrough,
      input.artifactDir,
    );
    await runAgentBrowser(input.sessionName, [
      "screenshot",
      path.join(input.artifactDir, "after.png"),
    ]);
    await runAgentBrowser(input.sessionName, [
      "screenshot",
      "--annotate",
      path.join(input.artifactDir, "annotated.png"),
    ]);
    await runAgentBrowser(input.sessionName, ["record", "stop"]);
  } finally {
    server.kill("SIGTERM");
    await flushServeLog();
    await runAgentBrowser(input.sessionName, ["close"]).catch(() => undefined);
    await cleanupAgentBrowserSession(input.sessionName);
  }
}
