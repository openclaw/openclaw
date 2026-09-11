import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchFallbackTaskScript } from "../daemon/schtasks-runtime.js";
import { spawnCommand, withCommandProcessScope } from "../process/exec-spawn.js";
import {
  retainCliProcessJobUntilExit,
  withCliCommandCleanup,
  withCliProcessScope,
} from "./runtime-cleanup-scope.js";

const [role, ownership, inherited, requestedCode, descendants, markerPath] = process.argv.slice(2);
const fixture = fileURLToPath(import.meta.url);
const args = [...process.execArgv, fixture];

if (role === "handoff-candidate") {
  if (!markerPath) {
    throw new Error("Fallback fixture requires its isolated marker path");
  }
  await withCliProcessScope(retainCliProcessJobUntilExit);
  const launchMutator = async () => {
    const child = spawnCommand([process.execPath, ...args, "launcher"], {
      stdio: ["ignore", "ignore", "inherit"],
      ipc: true,
    });
    const [message] = await once(child.nodeChildProcess, "message");
    await child;
    return Number(message.descendantPid);
  };
  let descendantPid: number | undefined;
  let settlement = "settled";
  let fallbackPid: number | undefined;
  if (ownership === "busy") {
    descendantPid = await launchMutator();
  }
  try {
    await launchFallbackTaskScript(
      { OPENCLAW_TASK_SCRIPT: path.join(path.dirname(markerPath), "gateway.cmd") },
      {
        programArguments: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},String(process.pid));setInterval(()=>{},1000);`,
        ],
      },
    );
    const deadline = Date.now() + 3_000;
    while (!existsSync(markerPath)) {
      if (Date.now() >= deadline) {
        throw new Error("Fallback did not publish its PID");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    fallbackPid = Number(readFileSync(markerPath, "utf8"));
    if (ownership === "rearm") {
      await withCommandProcessScope(async () => {
        descendantPid = await launchMutator();
      });
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "CommandProcessScopeUnsettledError") {
      throw error;
    }
    settlement = error.name;
  }
  writeSync(1, `${JSON.stringify({ descendantPid, fallbackPid, settlement })}\n`);
  process.exit(0);
} else if (role === "launcher") {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(()=>process.exit(0),30000);process.send('ready');process.disconnect();"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, detached: true },
  );
  await once(child, "message");
  process.send?.({ descendantPid: child.pid }, () => process.exit(0));
} else if (role === "candidate") {
  const { default: koffi } = await import("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const currentProcess = kernel32.func("__stdcall", "GetCurrentProcess", "void *", []);
  const isProcessInJob = kernel32.func("__stdcall", "IsProcessInJob", "int32_t", [
    "void *",
    "void *",
    koffi.out(koffi.pointer("int32_t")),
  ]);
  const wasInJob = [0];
  if (!isProcessInJob(currentProcess(), null, wasInJob)) {
    throw new Error("Could not inspect inherited Job membership");
  }
  if (ownership === "borrowed") {
    await retainCliProcessJobUntilExit();
  } else {
    await withCliProcessScope(() =>
      withCliCommandCleanup(ownership === "gateway", retainCliProcessJobUntilExit),
    );
  }
  let message: { descendantPid?: number } = {};
  let settlement = "settled";
  try {
    await withCommandProcessScope(async () => {
      const launcher = spawnCommand(
        descendants === "false"
          ? [process.execPath, "-e", "process.exit(0)"]
          : [process.execPath, ...args, "launcher"],
        { stdio: ["ignore", "ignore", "inherit"], ipc: true },
      );
      if (descendants !== "false") {
        [message] = await once(launcher.nodeChildProcess, "message");
      }
      await launcher;
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "CommandProcessScopeUnsettledError") {
      throw error;
    }
    settlement = error.name;
  }
  writeSync(
    1,
    `${JSON.stringify({ ...message, settlement, inheritedJob: wasInJob[0] === 1, launcherExited: true })}\n`,
  );
  process.exit(Number(requestedCode));
} else {
  if (inherited === "true") {
    await withCliProcessScope(retainCliProcessJobUntilExit);
  }
  const candidate = spawn(
    process.execPath,
    [
      ...args,
      role === "handoff-harness" ? "handoff-candidate" : "candidate",
      ownership!,
      inherited!,
      requestedCode!,
      descendants!,
      ...(markerPath ? [markerPath] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let stdout = "";
  let stderr = "";
  candidate.stdout.on("data", (chunk) => (stdout += String(chunk)));
  candidate.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const [code, signal] = await once(candidate, "close");
  // Stay alive until the test observes descendant exit. Closing an inherited
  // outer Job first would mask a missing Job in the candidate.
  process.once("message", () => process.exit(0));
  process.send?.({ code, signal, stdout, stderr });
}
