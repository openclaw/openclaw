import fs from "node:fs/promises";

export function createManagedServiceActivationScript(params: {
  sourceRuntimeImport: string;
  statePath: string;
  updaterScript: string;
  runnerFallback?: boolean;
  selectedDriver?: "2026.9.3";
}): string {
  if (params.selectedDriver) {
    // 2026.9.3, update-managed-service-handoff-B3PbeHMk.mjs:2380-2406:
    // activateManagedServiceUpdateHandoff writes park\n and accepts only parked\n.
    // Split that shipped request across an explicit gate to exercise partial frames.
    return `void (async () => {
      const legacyFs = require("node:fs");
      const legacyStatePath = ${JSON.stringify(params.statePath)};
      await new Promise((resolve, reject) => {
        let buffered = "";
        const cleanup = () => {
          clearInterval(release);
          process.stdin.off("data", onData).off("end", onEnd).off("error", onError);
          process.stdin.pause();
        };
        const onError = (error) => { cleanup(); reject(error); };
        const onEnd = () => onError(new Error("managed update activation control closed"));
        const onData = (chunk) => {
          buffered += chunk.toString();
          if (!buffered.includes("\\n") && buffered.length < 64) return;
          cleanup();
          if (buffered === "parked\\n") resolve();
          else reject(new Error("managed update activation was not confirmed"));
        };
        const release = setInterval(() => {
          if (!legacyFs.existsSync(legacyStatePath + ".park-tail")) return;
          clearInterval(release);
          process.stdout.write("rk\\n", (error) => { if (error) onError(error); });
        }, 5);
        process.stdin.on("data", onData).once("end", onEnd).once("error", onError);
        process.stdout.write("pa", (error) => {
          if (error) onError(error);
          else legacyFs.writeFileSync(legacyStatePath + ".park-prefix", "sent");
        });
      });
      const legacyState = JSON.parse(legacyFs.readFileSync(legacyStatePath, "utf8"));
      legacyState.selectedDriverVersion = "2026.9.3";
      legacyState.selectedDriverArgs = process.argv.slice(2);
      legacyFs.writeFileSync(legacyStatePath, JSON.stringify(legacyState));
      ${params.updaterScript}
    })().catch((error) => { console.error(error); process.exit(18); });`;
  }
  if (params.runnerFallback) {
    return `void (async () => { ${params.sourceRuntimeImport}
      await new Promise((resolve,reject) => { process.stdin.once("data", reply => reply.toString() === "parked\\n" ? resolve() : reject(new Error("activation refused"))); process.stdout.write("park\\n"); }); ${params.updaterScript}
    })().catch((error) => { console.error(error); process.exit(18); });`;
  }
  return `process.stdin.once("data", (reply) => { if (reply.toString() !== "parked\\n") process.exit(18); ${params.updaterScript} }); process.stdout.write("park\\n");`;
}

export async function readSavedFailure(contextPath: string) {
  const exists = await fs.access(contextPath).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return null;
  }
  return {
    path: contextPath,
    mode: (await fs.stat(contextPath)).mode & 0o777,
    contents: JSON.parse(await fs.readFile(contextPath, "utf8")),
  };
}
