import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_LINEAGE_START_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { completeWorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import {
  WORKER_NATIVE_INFERENCE_STARTUP_ENV,
  projectNativeInferenceStartup,
} from "../worker/native-inference-startup.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import * as launchTransport from "./node-worker-launch-transport.js";
import {
  nodeWorkerNativeInferenceSecrets,
  snapshotNodeWorkerNativeInference,
} from "./node-worker-native-inference.js";
import { createNodeWorkerCredentialScrubber } from "./node-worker-output.js";
import { requireNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import { nodeWorkerEnvironmentBinding } from "./node-worker-supervisor-ownership.js";
import { waitForNodeWorkerTerminal } from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const credential = "synthetic-native-key";
const header = "synthetic-native-header";

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
});

function nativeWorkerSource(source = TEST_WORKER_SOURCE) {
  return source.replace(
    "await start;",
    `const startupCarrier = process.env.OPENCLAW_WORKER_NATIVE_INFERENCE_STARTUP;
delete process.env.OPENCLAW_WORKER_NATIVE_INFERENCE_STARTUP;
let nativeStartup;
let startupClosed = false;
if (startupCarrier !== undefined) {
  if (startupCarrier !== "3") throw new Error("Invalid private startup descriptor");
  try { nativeStartup = JSON.parse(fs.readFileSync(3, "utf8")); }
  finally { fs.closeSync(3); startupClosed = true; }
}
await start;`,
  );
}

function createFixture() {
  const fixture = writeNodeWorkerFixture(tempDirs.make("node-native-inference-"));
  fs.writeFileSync(
    path.join(fixture.bundleRoot, "gateway-1", "bundles", "a".repeat(64), "worker.mjs"),
    nativeWorkerSource(),
  );
  const configPath = path.join(fixture.root, "native.json");
  const config = {
    models: [
      {
        provider: "provider-1",
        id: "model-1",
        api: "openai-completions",
        baseUrl: "https://model.example.test/v1",
        contextWindow: 8192,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        apiKeyEnv: "NATIVE_TEST_KEY",
        headers: { "x-private": header },
      },
    ],
    workspaces: [
      {
        id: "agent-1",
        path: fixture.workspaceDir,
        sessionId: "session-1",
        models: ["provider-1/model-1"],
      },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const env = {
    ...fixture.env,
    NATIVE_TEST_KEY: credential,
    UNRELATED_SECRET: "unrelated-secret",
    [WORKER_NATIVE_INFERENCE_STARTUP_ENV]: "untrusted-carrier",
  };
  return { ...fixture, env, config, configPath };
}

function nativeInput(workspaceDir: string, turnId = "native-turn", prompt = "success") {
  const input = testWorkerLaunchInput(workspaceDir, turnId, prompt);
  input.descriptor.assignment.inference = "runtime-local";
  return input;
}

it("leaves Windows defaults unchanged and rejects only native inference opt-in", () => {
  const { configPath, env } = createFixture();
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  try {
    expect(snapshotNodeWorkerNativeInference(undefined, env)).toBeUndefined();
    expect(() => snapshotNodeWorkerNativeInference(configPath, env)).toThrow(
      "Worker-local inference is not supported on Windows yet",
    );
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

// Windows native startup is deferred; its opt-in refusal and unchanged default are tested above.
describe.skipIf(process.platform === "win32")("node-local native inference startup custody", () => {
  it.each(["omitted", "unknown"])(
    "rejects %s model grants before supervisor credential capture",
    (grantKind) => {
      const f = createFixture();
      const { models: _models, ...workspace } = f.config.workspaces[0]!;
      const config = {
        ...f.config,
        models: [
          ...f.config.models,
          { ...f.config.models[0]!, id: "other-model", apiKeyEnv: "OTHER_AGENT_KEY" },
        ],
        workspaces: [
          {
            ...workspace,
            ...(grantKind === "unknown" ? { models: ["provider-1/model-1", "missing/model"] } : {}),
          },
        ],
      };
      fs.writeFileSync(f.configPath, JSON.stringify(config));
      const reads = vi.fn(() => "synthetic-grant-credential");
      for (const name of ["NATIVE_TEST_KEY", "OTHER_AGENT_KEY"]) {
        Object.defineProperty(f.env, name, { get: reads, enumerable: true });
      }
      expect(() =>
        createNodeWorkerSupervisor({
          bundleRoot: f.bundleRoot,
          env: f.env,
          nativeInferenceConfig: f.configPath,
        }),
      ).toThrow("Node worker native inference configuration is invalid or unavailable");
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it("projects the complete explicit agent grant, not just the current turn or other agents", () => {
    const f = createFixture();
    f.config.models.push(
      { ...f.config.models[0]!, id: "same-agent-model", apiKeyEnv: "SAME_AGENT_KEY" },
      {
        ...f.config.models[0]!,
        id: "other-model",
        apiKeyEnv: "OTHER_AGENT_KEY",
        headers: { "x-private": "other-agent-header" },
      },
    );
    f.config.workspaces[0]!.models.push("provider-1/same-agent-model");
    f.config.workspaces.push({
      id: "other-agent",
      path: f.root,
      sessionId: "other-session",
      models: ["provider-1/other-model"],
    });
    fs.writeFileSync(f.configPath, JSON.stringify(f.config));
    const startup = snapshotNodeWorkerNativeInference(f.configPath, {
      ...f.env,
      SAME_AGENT_KEY: "synthetic-same-agent-key",
      OTHER_AGENT_KEY: "synthetic-other-agent-key",
    })!;
    const descriptor = completeWorkerLaunchDescriptor(
      nativeInput(f.workspaceDir).descriptor,
      TEST_WORKER_ENDPOINT,
    );
    const projected = projectNativeInferenceStartup(startup, descriptor);
    expect(projected.config.workspaces).toHaveLength(1);
    expect(projected.config.models.map((model) => model.id)).toEqual([
      "model-1",
      "same-agent-model",
    ]);
    expect(projected.credentials).toEqual({
      NATIVE_TEST_KEY: credential,
      SAME_AGENT_KEY: "synthetic-same-agent-key",
    });
    expect(JSON.stringify(projected)).not.toContain("other-agent");
    expect(projected.credentials).not.toHaveProperty("OTHER_AGENT_KEY");
    expect(projected.config.workspaces[0]!.id).toBe("agent-1");
    expect(projected.config.models[0]!.cost).not.toBe(startup.config.models[0]!.cost);
    delete startup.credentials.NATIVE_TEST_KEY;
    expect(() => projectNativeInferenceStartup(startup, descriptor)).toThrow();
  });

  it("admits generated workspaces under an explicit canonical root and rejects escapes", () => {
    const f = createFixture();
    const startup = snapshotNodeWorkerNativeInference(f.configPath, f.env)!;
    startup.config.workspaces[0] = {
      ...startup.config.workspaces[0]!,
      path: f.root,
      scope: "subdirectories",
    };
    const descriptor = completeWorkerLaunchDescriptor(
      nativeInput(f.workspaceDir).descriptor,
      TEST_WORKER_ENDPOINT,
    );
    expect(projectNativeInferenceStartup(startup, descriptor).config.workspaces[0]!.path).toBe(
      fs.realpathSync(f.root),
    );
    descriptor.assignment.workspaceDir = path.dirname(f.root);
    expect(() => projectNativeInferenceStartup(startup, descriptor)).toThrow("not authorized");
    const link = path.join(f.root, "outside-link");
    fs.symlinkSync(path.dirname(f.root), link, "junction");
    descriptor.assignment.workspaceDir = link;
    expect(() => projectNativeInferenceStartup(startup, descriptor)).toThrow("escapes");
  });
  it("reads a shared named credential once for all startup models", () => {
    const f = createFixture();
    f.config.models.push({ ...f.config.models[0]!, id: "second-model" });
    fs.writeFileSync(f.configPath, JSON.stringify(f.config));
    const readCredential = vi.fn(() => credential);
    Object.defineProperty(f.env, "NATIVE_TEST_KEY", { get: readCredential, enumerable: true });
    const startup = snapshotNodeWorkerNativeInference(f.configPath, f.env)!;
    expect(readCredential).toHaveBeenCalledOnce();
    expect(startup.credentials).toEqual({ NATIVE_TEST_KEY: credential });
  });

  it("snapshots only referenced credentials and header bytes without changing worker environments", () => {
    const { configPath, env, config } = createFixture();
    const startup = snapshotNodeWorkerNativeInference(configPath, env)!;
    env.NATIVE_TEST_KEY = "changed-after-snapshot";
    fs.writeFileSync(configPath, "invalid after snapshot");
    expect(startup.config).toEqual(config);
    expect(startup.credentials).toEqual({ NATIVE_TEST_KEY: credential });
    expect(nodeWorkerNativeInferenceSecrets(startup)).toEqual([credential, header]);
    const workerEnv = snapshotNodeWorkerEnv(env);
    expect(workerEnv.NATIVE_TEST_KEY).toBeUndefined();
    expect(workerEnv.UNRELATED_SECRET).toBeUndefined();
    expect(workerEnv[WORKER_NATIVE_INFERENCE_STARTUP_ENV]).toBeUndefined();
    expect(snapshotNodeWorkerNativeInference(undefined, env)).toBeUndefined();
  });

  it.each([undefined, "", "  "])("fails closed on missing named credentials (%j)", (value) => {
    const { configPath, env } = createFixture();
    expect(() =>
      snapshotNodeWorkerNativeInference(configPath, { ...env, NATIVE_TEST_KEY: value }),
    ).toThrow("Node worker native inference credential is unavailable");
  });

  it("rejects relative, unreadable and invalid files without exposing source bytes", () => {
    const { configPath, env } = createFixture();
    expect(() => snapshotNodeWorkerNativeInference("native.json", env)).toThrow("absolute path");
    fs.writeFileSync(configPath, credential);
    expect(() => snapshotNodeWorkerNativeInference(configPath, env)).toThrow(
      "Node worker native inference configuration is invalid or unavailable",
    );
    fs.unlinkSync(configPath);
    expect(() => snapshotNodeWorkerNativeInference(configPath, env)).toThrow(
      "Node worker native inference configuration is invalid or unavailable",
    );
  });

  it("captures config and credentials in the constructor before any initialization", async () => {
    const f = createFixture();
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot: f.bundleRoot,
      env: f.env,
      nativeInferenceConfig: f.configPath,
    });
    f.env.NATIVE_TEST_KEY = "changed-before-initialize";
    fs.writeFileSync(f.configPath, "invalid before initialize");
    const prepare = launchTransport.prepareNodeWorkerLaunchTransport;
    const seen = vi
      .spyOn(launchTransport, "prepareNodeWorkerLaunchTransport")
      .mockImplementation(async (options) => {
        expect(options.nativeInferenceStartup?.credentials).toEqual({
          NATIVE_TEST_KEY: credential,
        });
        expect(options.nativeInferenceStartup?.config).toEqual(f.config);
        expect(options.workerEnv.NATIVE_TEST_KEY).toBeUndefined();
        expect(options.workerEnv[WORKER_NATIVE_INFERENCE_STARTUP_ENV]).toBeUndefined();
        return await prepare(options);
      });
    try {
      await supervisor.launch(nativeInput(f.workspaceDir), TEST_WORKER_ENDPOINT);
      expect((await waitForNodeWorkerTerminal(supervisor, "native-turn")).state).toBe("completed");
      expect(seen).toHaveBeenCalledOnce();
    } finally {
      await supervisor.close();
    }
  });

  it("rejects invalid local startup configuration synchronously at supervisor construction", () => {
    const f = createFixture();
    expect(() =>
      createNodeWorkerSupervisor({
        bundleRoot: f.bundleRoot,
        env: { ...f.env, NATIVE_TEST_KEY: undefined },
        nativeInferenceConfig: f.configPath,
      }),
    ).toThrow("Node worker native inference credential is unavailable");
  });

  it("does not treat an ambient startup carrier as local configuration", async () => {
    const f = createFixture();
    const supervisor = createNodeWorkerSupervisor({ bundleRoot: f.bundleRoot, env: f.env });
    try {
      expect(
        await supervisor.launch(nativeInput(f.workspaceDir), TEST_WORKER_ENDPOINT),
      ).toMatchObject({
        state: "failed",
        errorText: "Node worker native inference requires node-local startup configuration",
      });
      expect(fs.existsSync(path.join(f.workspaceDir, "native-turn.started.json"))).toBe(false);
    } finally {
      await supervisor.close();
    }
  });

  it("rejects nested container inference before spawning an engine", async () => {
    const f = createFixture();
    const input = nativeInput(f.workspaceDir);
    const journal = new NodeWorkerJournalWorker({ env: f.env });
    await expect(
      launchTransport.prepareNodeWorkerLaunchTransport({
        bundleRoot: f.bundleRoot,
        workerEnv: snapshotNodeWorkerEnv(f.env),
        engineEnv: {},
        nativeInferenceStartup: snapshotNodeWorkerNativeInference(f.configPath, f.env),
        input,
        descriptor: completeWorkerLaunchDescriptor(input.descriptor, TEST_WORKER_ENDPOINT),
        planHash: "synthetic-plan",
        supervisor: requireNodeWorkerProcessIdentity(process.pid),
        connectionFailure: {},
        scrubber: createNodeWorkerCredentialScrubber(credential),
        store: new NodeWorkerLaunchStore(journal),
        containerEngine: { id: "docker", command: "must-not-execute", target: "synthetic-target" },
      }),
    ).rejects.toThrow("requires isolation none, not a nested container");
  });

  it.each(["agent", "workspace", "session", "model"])(
    "rejects unauthorized %s before child creation",
    async (mismatch) => {
      const f = createFixture();
      f.config.models.push({
        ...f.config.models[0]!,
        id: "other-model",
        apiKeyEnv: "OTHER_AGENT_KEY",
      });
      Object.assign(f.env, { OTHER_AGENT_KEY: "synthetic-other-agent-key" });
      fs.writeFileSync(f.configPath, JSON.stringify(f.config));
      const supervisor = createNodeWorkerSupervisor({
        bundleRoot: f.bundleRoot,
        env: f.env,
        nativeInferenceConfig: f.configPath,
      });
      const input = nativeInput(f.workspaceDir);
      if (mismatch === "agent") {
        input.descriptor.assignment.agentId = "other-agent";
      }
      if (mismatch === "workspace") {
        input.descriptor.assignment.workspaceDir = path.join(f.root, "other");
      }
      if (mismatch === "session") {
        input.descriptor.admission.sessionId = "other-session";
      }
      if (mismatch === "model") {
        input.descriptor.assignment.modelRef = {
          ...input.descriptor.assignment.modelRef,
          model: "other-model",
        };
      }
      try {
        expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
          state: "failed",
        });
        expect(fs.existsSync(path.join(f.workspaceDir, "native-turn.started.json"))).toBe(false);
      } finally {
        await supervisor.close();
      }
    },
  );

  it("binds retained environment identity to inference custody", () => {
    const input = testWorkerLaunchInput("/workspace", "turn");
    const proxied = nodeWorkerEnvironmentBinding(input);
    input.descriptor.assignment.inference = "runtime-local";
    expect(nodeWorkerEnvironmentBinding(input)).not.toEqual(proxied);
  });

  it.each([
    { native: false, lineage: false },
    { native: true, lineage: false },
    ...(process.platform === "linux" || process.platform === "darwin"
      ? [{ native: true, lineage: true }]
      : []),
  ])(
    "delivers private startup before the journal gate (native=$native, lineage=$lineage)",
    async ({ native, lineage }) => {
      const f = createFixture();
      f.config.models.push({
        ...f.config.models[0]!,
        id: "other-model",
        apiKeyEnv: "OTHER_AGENT_KEY",
      });
      Object.assign(f.env, { OTHER_AGENT_KEY: "synthetic-other-agent-key" });
      fs.writeFileSync(f.configPath, JSON.stringify(f.config));
      // Exceed an anonymous pipe buffer: awaiting the start gate before draining deadlocks.
      f.env.NATIVE_TEST_KEY = credential.repeat(16 * 1024);
      const source = nativeWorkerSource().replace(
        "const mode = descriptor.assignment.prompt;",
        `writeArtifact(descriptor, "carrier", {
  present: nativeStartup !== undefined,
  markerOnly: startupCarrier === undefined || startupCarrier === "3",
  closed: startupClosed,
  removed: process.env.OPENCLAW_WORKER_NATIVE_INFERENCE_STARTUP === undefined,
  namedKey: process.env.NATIVE_TEST_KEY !== undefined,
  otherNamedKey: process.env.OTHER_AGENT_KEY !== undefined,
  models: nativeStartup?.config.models.map(model => model.provider + "/" + model.id) ?? [],
  credentialNames: Object.keys(nativeStartup?.credentials ?? {}),
});
const mode = descriptor.assignment.prompt;`,
      );
      fs.writeFileSync(
        path.join(f.bundleRoot, "gateway-1", "bundles", "a".repeat(64), "worker.mjs"),
        source,
      );
      const supervisor = createNodeWorkerSupervisor({
        bundleRoot: f.bundleRoot,
        env: f.env,
        nativeInferenceConfig: f.configPath,
      });
      const input = native
        ? nativeInput(f.workspaceDir)
        : testWorkerLaunchInput(f.workspaceDir, "native-turn");
      if (!lineage) {
        input.descriptor.admission.handshake.protocolFeatures =
          input.descriptor.admission.handshake.protocolFeatures.filter(
            (feature) => feature !== WORKER_LINEAGE_START_PROTOCOL_FEATURE,
          );
      }
      let checkedJournalGate = false;
      const markRunning = vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning");
      markRunning.mockImplementation(async function (this: NodeWorkerLaunchStore, params) {
        expect(fs.existsSync(path.join(f.workspaceDir, "native-turn.started.json"))).toBe(false);
        expect(params.cleanupMode).toBe(lineage ? "owned-anchor" : "process-group");
        checkedJournalGate = true;
        markRunning.mockRestore();
        return await this.markRunning(params);
      });
      try {
        await supervisor.launch(input, TEST_WORKER_ENDPOINT);
        expect((await waitForNodeWorkerTerminal(supervisor, input.launchId)).state).toBe(
          "completed",
        );
        expect(checkedJournalGate).toBe(true);
        expect(
          JSON.parse(
            fs.readFileSync(path.join(f.workspaceDir, "native-turn.carrier.json"), "utf8"),
          ),
        ).toEqual({
          present: native,
          markerOnly: true,
          closed: native,
          removed: true,
          namedKey: false,
          otherNamedKey: false,
          models: native ? ["provider-1/model-1"] : [],
          credentialNames: native ? ["NATIVE_TEST_KEY"] : [],
        });
      } finally {
        await supervisor.close();
      }
    },
  );

  it("scrubs captured keys and headers on initial and retained turns without global registry help", async () => {
    const f = createFixture();
    const source = nativeWorkerSource().replace(
      "const mode = descriptor.assignment.prompt;",
      `const mode = descriptor.assignment.prompt;
if (mode === "native-secret-fail") { fs.writeSync(2, nativeStartup.credentials.NATIVE_TEST_KEY + " " + nativeStartup.config.models[0].headers["x-private"]); exitWorker(7); return; }`,
    );
    fs.writeFileSync(
      path.join(f.bundleRoot, "gateway-1", "bundles", "a".repeat(64), "worker.mjs"),
      source,
    );
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot: f.bundleRoot,
      env: f.env,
      nativeInferenceConfig: f.configPath,
    });
    const prepare = launchTransport.prepareNodeWorkerLaunchTransport;
    vi.spyOn(launchTransport, "prepareNodeWorkerLaunchTransport").mockImplementation(
      async (options) => {
        resetSecretRedactionRegistryForTest();
        return await prepare(options);
      },
    );
    const releaseClaim = createDeferred();
    try {
      await supervisor.launch(
        nativeInput(f.workspaceDir, "first", "native-secret-fail"),
        TEST_WORKER_ENDPOINT,
      );
      const first = await waitForNodeWorkerTerminal(supervisor, "first");
      expect(first.state).toBe("failed");
      expect(first.errorText).toContain("[REDACTED] [REDACTED]");
      expect(first.errorText).not.toContain(credential);
      expect(first.errorText).not.toContain(header);
      await supervisor.launch(
        nativeInput(f.workspaceDir, "retained", "diagnostic-retain"),
        TEST_WORKER_ENDPOINT,
      );
      await waitForNodeWorkerTerminal(supervisor, "retained");
      resetSecretRedactionRegistryForTest();
      const claimEntered = createDeferred();
      const claimSpy = vi.spyOn(NodeWorkerTurnStore.prototype, "claim");
      claimSpy.mockImplementation(async function (this: NodeWorkerTurnStore, params, authority) {
        if (params.claim.launchId === "next") {
          claimEntered.resolve();
          await releaseClaim.promise;
        }
        claimSpy.mockRestore();
        return await this.claim(params, authority);
      });
      const send = launchTransport.sendNodeWorkerInput;
      vi.spyOn(launchTransport, "sendNodeWorkerInput").mockImplementation(async (...args) => {
        resetSecretRedactionRegistryForTest();
        return await send(...args);
      });
      const nextLaunch = supervisor.launch(
        nativeInput(f.workspaceDir, "next", "native-secret-fail"),
        TEST_WORKER_ENDPOINT,
      );
      await claimEntered.promise;
      releaseClaim.resolve();
      await nextLaunch;
      const next = await waitForNodeWorkerTerminal(supervisor, "next");
      expect(next.state).toBe("failed");
      expect(next.errorText).toContain("[REDACTED] [REDACTED]");
      expect(next.errorText).not.toContain(credential);
      expect(next.errorText).not.toContain(header);
    } finally {
      releaseClaim.resolve();
      await supervisor.close();
    }
  });
});
