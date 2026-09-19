// Keep this real-process proof separate from the mocked recovery discovery suite.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("runtime recovery Gateway drain (real child)", () => {
  it.runIf(process.platform !== "win32")(
    "preserves a real HTTP final response and persisted effect beyond two seconds",
    async () => {
      const child = spawn(
        process.execPath,
        [
          path.resolve("scripts/proof/gateway-launcher-drain-shutdown-proof.mjs"),
          "--mode=recovery",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data: string) => {
        stderr += data;
      });
      const [code, signal] = await once(child, "exit");
      expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
      expect(JSON.parse(stdout)).toMatchObject({
        mode: "recovery",
        finalEffect: true,
        deniedAdmission: 503,
      });
    },
    20_000,
  );
});

// This exercises real Node IPC and real handlers with the Windows policy selected.
// It is not native Windows console/service or managed updater acceptance.
describe("Gateway Windows-policy IPC transport (host-independent)", () => {
  it.each([
    { depth: 0, signal: "SIGTERM", expected: "SIGTERM" },
    { depth: 2, signal: "SIGINT", expected: "SIGINT" },
    { depth: 1, signal: "SIGBREAK", expected: "SIGINT" },
    { depth: 0, signal: "disconnect", expected: "SIGTERM" },
    { depth: 0, signal: "console-break", expected: "SIGINT" },
    { depth: 0, signal: "console-int", expected: "SIGINT" },
    { depth: 0, signal: "console-int-handoff", expected: "SIGINT" },
  ])(
    "drains through $depth wrappers after $signal during startup",
    async (scenario) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-launcher-ipc-"));
      const fixture = path.join(directory, "fixture.mjs");
      const recovery = pathToFileURL(path.resolve("node-runtime-recovery.mjs")).href;
      await writeFile(
        fixture,
        `
        const depth = Number(process.argv[2]);
        const fixture = process.argv[1];
        Object.defineProperty(process, "platform", { value: "win32" });
        process.argv = [process.execPath, fixture, "gateway", "run"];
        const { runRespawnedChild } = await import(${JSON.stringify(recovery)});
        let interruptOnHandoff = false;
        process.on("message", (message) => {
          if (message?.type === "fixture.console-break") process.emit("SIGBREAK");
          if (message?.type === "fixture.console-int") {
            process.emit("SIGINT");
            process.emit("SIGINT");
          }
          if (message?.type === "fixture.console-int-handoff") interruptOnHandoff = true;
        });
        // Keep startup alive independently of IPC, as a real Gateway startup does.
        const lifetime = setInterval(() => {}, 1000);
        if (depth > 0) {
          runRespawnedChild(process.execPath, [fixture, String(depth - 1)], process.env);
          process.send?.({ ready: true });
        } else {
          process.send?.({ ready: true });
          setTimeout(() => {
            let stopping = false;
            let deliveries = 0;
            for (const signal of ["SIGTERM", "SIGINT"]) {
              process.on(signal, () => {
                deliveries++;
                if (stopping) return;
                stopping = true;
                setTimeout(() => {
                  process.stdout.write("drained:" + signal + ":" + deliveries);
                  clearInterval(lifetime);
                }, 75);
              });
            }
            // Exercise a signal after handler insertion but before newListener
            // nextTick callbacks release the startup handoff.
            if (interruptOnHandoff) process.emit("SIGINT");
          }, 100);
        }
      `,
      );
      const child = spawn(process.execPath, [fixture, String(scenario.depth)], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      child.stderr!.setEncoding("utf8").on("data", (data: string) => {
        stderr += data;
      });
      const exited = once(child, "exit");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await once(child, "message");
        if (scenario.signal === "disconnect") {
          child.disconnect();
        } else if (scenario.signal.startsWith("console-")) {
          child.send({ type: `fixture.${scenario.signal}` });
        } else {
          child.send({ type: "unrelated-message", signal: "SIGTERM" });
          child.send({ type: "openclaw.launcher.gateway-stop", signal: "SIGKILL" });
          child.send({ type: "openclaw.launcher.gateway-stop", signal: scenario.signal });
        }
        const [code, signal] = await exited;
        expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
        expect(stdout).toBe(`drained:${scenario.expected}:1`);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
