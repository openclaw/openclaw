import fs from "node:fs/promises";

function createManagedNativeUpdaterScript(params: {
  sourceRuntimeImport: string;
  installRoot: string;
  runId?: string;
  statePath: string;
  updaterScript: string;
  refuseStop?: boolean;
  timeoutStop?: boolean;
  failPreparation?: boolean;
  failPersistenceAck?: boolean;
  failCommitAck?: boolean;
}): string {
  return `void (async () => {
    ${params.sourceRuntimeImport}
    const { prepareRetainedNativeTestPeer } = await import(${JSON.stringify(new URL("./update-managed-service-native-peer.test-support.ts", import.meta.url).href)});
    const admission = await prepareRetainedNativeTestPeer({ assertCurrent: () => {}, timeoutMs: ${params.timeoutStop ? 1_000 : 30_000} });
    if (${params.failPreparation === true}) throw new Error("startup failed before persistence");
    const { createRetainedUpdateRecovery } = await import(${JSON.stringify(new URL("./update-retained-recovery.test-support.ts", import.meta.url).href)});
    const runtime = { root: ${JSON.stringify(params.installRoot)}, nodePath: process.execPath, version: "1.0.0", buildId: null };
    const persisted = createRetainedUpdateRecovery({ runId: ${JSON.stringify(params.runId)}, from: runtime, to: { ...runtime, version: "2.0.0" } });
    if (${params.failPersistenceAck === true}) throw new Error("startup persistence acknowledgement lost");
    const { loadUpdateRecovery } = await import(${JSON.stringify(new URL("./update-run-recovery.ts", import.meta.url).href)});
    await admission.commit(() => { if (JSON.stringify(loadUpdateRecovery(persisted.runId)) !== JSON.stringify(persisted)) throw new Error("retained fixture changed"); });
    if (${params.failCommitAck === true}) throw new Error("startup commit acknowledgement lost");
    const nativeFs = require("node:fs");
    const statePath = ${JSON.stringify(params.statePath)};
    const nativeEffect = async (action, effect) => {
      const record = (phase) => {
        const state = nativeFs.existsSync(statePath) ? JSON.parse(nativeFs.readFileSync(statePath, "utf8")) : {};
        state.nativeActions = [...(state.nativeActions || []), action + ":" + phase];
        nativeFs.writeFileSync(statePath, JSON.stringify(state));
      };
      record("intent");
      if (${params.refuseStop === true} && action === "stop") throw new Error("native stop intent retained");
      try { await effect(() => {}); }
      finally {
        if (${params.timeoutStop === true} && action === "stop")
          nativeFs.writeFileSync(statePath + ".native-release", nativeFs.readFileSync(statePath));
      }
      record("observed");
    };
    await admission.activate({
      suppress: (effect) => nativeEffect("suppress", effect),
      stop: (effect) => nativeEffect("stop", effect),
    });
    ${params.updaterScript}
  })().catch((error) => { console.error(error); process.exit(18); });`;
}

export function createManagedServiceActivationScript(params: {
  sourceRuntimeImport: string;
  installRoot: string;
  runId?: string;
  statePath: string;
  updaterScript: string;
  nativePreparation?:
    | "complete"
    | "refuse-stop"
    | "timeout-stop"
    | "fail-preparation"
    | "fail-persistence-ack"
    | "fail-commit-ack";
  runnerFallback?: boolean;
}): string {
  if (params.nativePreparation) {
    return createManagedNativeUpdaterScript({
      ...params,
      refuseStop: params.nativePreparation === "refuse-stop",
      timeoutStop: params.nativePreparation === "timeout-stop",
      failPreparation: params.nativePreparation === "fail-preparation",
      failPersistenceAck: params.nativePreparation === "fail-persistence-ack",
      failCommitAck: params.nativePreparation === "fail-commit-ack",
    });
  }
  if (params.runnerFallback) {
    return `void (async () => { ${params.sourceRuntimeImport}
      await new Promise((resolve,reject) => { process.stdin.once("data", reply => reply.toString() === "parked\\n" ? resolve() : reject(new Error("activation refused"))); process.stdout.write("park\\n"); }); ${params.updaterScript}
    })().catch((error) => { console.error(error); process.exit(18); });`;
  }
  return `process.stdin.once("data", (reply) => { if (reply.toString() !== "parked\\n") process.exit(18); ${params.updaterScript} }); process.stdout.write("park\\n");`;
}

export async function readNativeState(statePath: string): Promise<Record<string, unknown>> {
  return {
    ...(JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{}")) as Record<
      string,
      unknown
    >),
    nativeRelease: JSON.parse(
      await fs.readFile(statePath + ".native-release", "utf8").catch(() => "{}"),
    ),
  };
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
