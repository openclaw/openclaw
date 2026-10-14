import { describe, expect, it } from "vitest";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_INFERENCE_MAX_CONTEXT_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import type { WorkerGitHubLaunchBinding, WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { buildWorkerConnectParams, parseWorkerLaunchDescriptor } from "./launch-descriptor.js";

function launchDescriptor(): WorkerLaunchDescriptor {
  return {
    version: 4,
    connectionEndpoint: { kind: "unix", socketPath: "/tmp/openclaw-worker/gateway.sock" },
    admission: {
      environmentId: "environment-1",
      credential: ["worker", "fixture", "value"].join("-"),
      sessionId: "session-1",
      ownerEpoch: 3,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      handshake: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.7.12",
        protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
      },
    },
    assignment: {
      agentId: "agent-1",
      operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
      agentRuntimeIdentityToken: "signed-runtime-token",
      runId: "run-1",
      turnId: "turn-1",
      prompt: "Inspect the workspace.",
      suppressPromptTranscript: false,
      workspaceDir: "/tmp/openclaw-worker/workspace",
      permissionMode: "workspace",
      workerContainmentRoot: "/tmp/openclaw-worker/workspace",
      modelRef: { provider: "provider-1", model: "model-1" },
      inferenceOptions: { reasoning: "medium", maxTokens: 512 },
      initialMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "Earlier context." }],
          timestamp: 1,
        },
      ],
      transcript: { baseLeafId: "leaf-7", nextSeq: 8 },
      liveEvents: { ackedSeq: 12, nextSeq: 13 },
      toolAuthority: {
        allowedToolNames: ["read", "exec"],
        exec: { host: "gateway", security: "full", ask: "off" },
      },
    },
  };
}

// Legacy-shape descriptors may fail closed through whole-descriptor rejection or
// parsed denied exec authority, so accept either outcome here.
function expectExecDeniedOrDescriptorRejected(candidate: unknown): void {
  let parsed: WorkerLaunchDescriptor;
  try {
    parsed = parseWorkerLaunchDescriptor(candidate);
  } catch (error) {
    expect(error).toMatchObject({ message: "invalid worker launch descriptor" });
    return;
  }
  const { exec } = parsed.assignment.toolAuthority;
  if (exec !== undefined) {
    expect(exec).toMatchObject({ security: "deny", ask: "off" });
  }
  expect(exec?.security).not.toBe("full");
}

function expectInvalidDescriptor(candidate: unknown) {
  expect(() => parseWorkerLaunchDescriptor(candidate)).toThrow("invalid worker launch descriptor");
}

function withAssignment(overrides: Record<string, unknown>, descriptor = launchDescriptor()) {
  return { ...descriptor, assignment: { ...descriptor.assignment, ...overrides } };
}

describe("worker launch descriptor", () => {
  it("admits bounded image-only input and replay without raising the text budget", () => {
    const descriptor = launchDescriptor();
    const image = {
      type: "image" as const,
      data: createNoisyPngBuffer(256, 256).toString("base64"),
      mimeType: "image/png",
    };
    expect(image.data.length).toBeGreaterThan(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES);
    descriptor.assignment.prompt = [image];
    descriptor.assignment.initialMessages = [{ role: "user", content: [image], timestamp: 1 }];
    for (const suppressPromptTranscript of [false, true]) {
      descriptor.assignment.suppressPromptTranscript = suppressPromptTranscript;
      expect(parseWorkerLaunchDescriptor(descriptor)).toEqual(descriptor);
    }
    for (const invalidImage of [
      { ...image, data: "" },
      { ...image, type: "text" },
      { ...image, extra: true },
    ]) {
      expectInvalidDescriptor(withAssignment({ prompt: [invalidImage] }, descriptor));
    }
    for (const prompt of [
      "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES),
      [{ type: "text", text: "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) }, image],
      [{ ...image, data: "x".repeat(WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES) }],
    ]) {
      expectInvalidDescriptor(withAssignment({ prompt }, descriptor));
    }
  });

  it.each(["workspaceDir", "workerContainmentRoot"] as const)(
    "requires absolute bounded %s paths through the project preparation limit",
    (field) => {
      for (const root of ["/", "C:\\", "\\\\server\\share\\"]) {
        for (const length of [257, 4_096]) {
          const descriptor = launchDescriptor();
          descriptor.assignment[field] = root + "a".repeat(length - root.length);

          expect(parseWorkerLaunchDescriptor(descriptor)).toEqual(descriptor);
        }
      }
      for (const value of [
        "/" + "a".repeat(4_096),
        "/workspace\0other",
        " /workspace",
        "/workspace ",
        "",
        "workspace",
        null,
      ]) {
        expectInvalidDescriptor(withAssignment({ [field]: value }));
      }
    },
  );

  it("round-trips turn-bound GitHub identity without adding it to worker admission", () => {
    const descriptor = launchDescriptor();
    const identity = {
      token: "worker-github-token",
      login: "worker-bot",
      branch: "session/worker-1",
    };
    for (const github of [
      undefined,
      identity,
      {
        ...identity,
        remoteUrl: "https://github.com/openclaw/openclaw.git",
        gitAuthor: { name: "Worker Bot", email: "worker@example.test" },
      },
    ]) {
      if (github) {
        descriptor.assignment.github = github;
      }
      const parsed = parseWorkerLaunchDescriptor(structuredClone(descriptor));
      expect(parsed).toEqual(descriptor);
      expect(parsed.assignment.github).toEqual(github);
      const connectParams = buildWorkerConnectParams(parsed);
      expect(connectParams).toMatchObject({
        role: "worker",
        client: { id: "openclaw-worker", mode: "worker", version: "2026.7.12" },
        admission: { ...descriptor.admission, runId: descriptor.assignment.runId },
      });
      expect(connectParams).not.toHaveProperty("github");
      if (github) {
        expect(JSON.stringify(connectParams)).not.toContain(github.token);
      }
    }
  });

  it("rejects malformed or open GitHub launch bindings", () => {
    const github: WorkerGitHubLaunchBinding = {
      token: "worker-github-token",
      login: "worker-bot",
      branch: "session/worker-1",
    };
    const withBinding = (overrides: Record<string, unknown>) =>
      Object.assign({}, github, overrides);
    const invalidBindings: unknown[] = [
      null,
      withBinding({ unexpected: true }),
      { login: github.login, branch: github.branch },
      { token: github.token, branch: github.branch },
      { token: github.token, login: github.login },
      ...["", "token with space", "token\n", "token\u0001", "x".repeat(2049)].map((token) =>
        withBinding({ token }),
      ),
      ...["", "worker_bot", "worker.bot", "worker\n", "x".repeat(40)].map((login) =>
        withBinding({ login }),
      ),
      ...[
        "",
        "-branch",
        "branch with space",
        "branch\u0000",
        "x".repeat(257),
        ...["..", "~", "^", ":", "?", "*", "[", "\\", "@{"].map((part) => `branch${part}name`),
      ].map((branch) => withBinding({ branch })),
      ...[
        "http://github.com/openclaw/openclaw.git",
        "https://example.com/openclaw/openclaw.git",
        "git@github.com:openclaw/openclaw.git",
        "https://github.com/openclaw/openclaw.git?token=x",
        "https://github.com/openclaw/openclaw.git\n",
      ].map((remoteUrl) => withBinding({ remoteUrl })),
      withBinding({ gitAuthor: { unexpected: true } }),
      withBinding({ remoteUrl: undefined }),
      withBinding({ gitAuthor: undefined }),
      withBinding({ gitAuthor: { name: undefined } }),
      withBinding({ gitAuthor: { email: undefined } }),
      ...["name", "email"].flatMap((key) =>
        ["", " ", "author\nvalue", "author\rvalue", "author\u0000value", "x".repeat(257)].map(
          (value) => withBinding({ gitAuthor: { [key]: value } }),
        ),
      ),
      Object.assign(Object.create({ token: github.token }), {
        login: github.login,
        branch: github.branch,
      }),
      { ...github, gitAuthor: Object.create({ email: "inherited@example.test" }) },
    ];
    for (const binding of invalidBindings) {
      expectInvalidDescriptor(withAssignment({ github: binding }));
    }
  });

  it("accepts the permission context pair only when both fields are present", () => {
    const descriptor = launchDescriptor();
    const {
      permissionMode: _permissionMode,
      workerContainmentRoot: _root,
      ...withoutContext
    } = descriptor.assignment;
    expect(
      parseWorkerLaunchDescriptor({ ...descriptor, assignment: withoutContext }).assignment,
    ).toEqual(withoutContext);

    for (const assignment of [
      { ...withoutContext, permissionMode: "workspace" },
      { ...withoutContext, workerContainmentRoot: "/tmp/openclaw-worker/workspace" },
    ]) {
      expectInvalidDescriptor({ ...descriptor, assignment });
    }
  });

  it("accepts only closed Unix or public WebSocket connection endpoints", () => {
    const descriptor = launchDescriptor();
    descriptor.connectionEndpoint = {
      kind: "websocket",
      url: "wss://gateway.example/tenant/__openclaw__/worker",
      tlsFingerprint: "ab:".repeat(31) + "ab",
    };
    expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual({
      ...descriptor,
      connectionEndpoint: {
        ...descriptor.connectionEndpoint,
        tlsFingerprint: "ab".repeat(32),
      },
    });

    const invalidEndpoints: unknown[] = [
      { kind: "unix", socketPath: "gateway.sock" },
      { kind: "unix", socketPath: "/tmp/gateway:sock" },
      { kind: "websocket", url: "https://gateway.example/__openclaw__/worker" },
      { kind: "websocket", url: "ws://user@gateway.example/__openclaw__/worker" },
      { kind: "websocket", url: "wss://gateway.example/other" },
      { kind: "websocket", url: "wss://gateway.example/__openclaw__/worker?token=x" },
      {
        kind: "websocket",
        url: "ws://127.0.0.1/__openclaw__/worker",
        tlsFingerprint: "ab".repeat(32),
      },
      {
        kind: "websocket",
        url: "ws://127.0.0.1/__openclaw__/worker",
        cloudflareAccess: {
          clientId: "cf-worker-plaintext-id",
          clientSecret: "cf-worker-plaintext-secret",
        },
      },
      ...["", "ab:cd:ef", "g".repeat(64)].map((tlsFingerprint) => ({
        kind: "websocket",
        url: "wss://gateway.example/__openclaw__/worker",
        tlsFingerprint,
      })),
      { ...descriptor.connectionEndpoint, unexpected: true },
    ];
    for (const connectionEndpoint of invalidEndpoints) {
      expectInvalidDescriptor({ ...descriptor, connectionEndpoint });
    }
  });

  it("requires closed own fields at every launch-owned boundary", () => {
    const descriptor = launchDescriptor();
    const { version, ...ownFields } = descriptor;
    const cases: unknown[] = [
      Object.assign(Object.create({ version }), ownFields),
      { ...descriptor, unexpected: true },
      { ...descriptor, admission: { ...descriptor.admission, unexpected: true } },
      withAssignment({ unexpected: true }),
      withAssignment({
        operationalRunInstance: { instanceId: "instance-run-1", runId: "other-run" },
      }),
    ];
    for (const field of [
      "modelRef",
      "inferenceOptions",
      "transcript",
      "liveEvents",
      "toolAuthority",
    ] as const) {
      cases.push(
        withAssignment({ [field]: { ...descriptor.assignment[field], unexpected: true } }),
      );
    }

    for (const candidate of cases) {
      expectInvalidDescriptor(candidate);
    }
  });

  it("requires bounded unique tool names and admits Gateway-owned tools", () => {
    const descriptor = launchDescriptor();
    const { toolAuthority: _missing, ...assignmentWithoutAuthority } = descriptor.assignment;
    expectInvalidDescriptor({ ...descriptor, version: 3 });
    expectInvalidDescriptor({ ...descriptor, assignment: assignmentWithoutAuthority });
    for (const allowedToolNames of [
      ["read", "read"],
      [""],
      [" read"],
      ["x".repeat(WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH + 1)],
      Array.from({ length: 257 }, (_, index) => `tool_${index}`),
    ]) {
      expectInvalidDescriptor(withAssignment({ toolAuthority: { allowedToolNames } }));
    }
    for (const allowedToolNames of [[], ["browser"], ["read", "web_search", "custom_tool"]]) {
      descriptor.assignment.toolAuthority.allowedToolNames = allowedToolNames;
      expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);
    }
  });

  it("rejects or denies absent, malformed, and partially populated exec authority", () => {
    const descriptor = launchDescriptor();
    const { exec: _exec, ...nameOnlyAuthority } = descriptor.assignment.toolAuthority;
    expectExecDeniedOrDescriptorRejected(withAssignment({ toolAuthority: nameOnlyAuthority }));
    for (const exec of [
      null,
      {},
      { security: "deny" },
      { ask: "off" },
      { security: "full" },
      { security: "full", ask: "off" },
      { security: null, ask: "off" },
      { security: "deny", ask: false },
      { host: "gateway", security: "full", ask: "off", unexpected: true },
      ...[undefined, null, false, {}, ["head"], ["/usr/bin/head"]].map((safeBins) => ({
        host: "gateway",
        security: "allowlist",
        ask: "off",
        safeBins,
      })),
      { host: "gateway", security: "full", ask: "off", node: "worker-node" },
      { host: "gateway", security: "full", ask: "off", nodeCwd: "/remote/workspace" },
      { host: "elsewhere", security: "full", ask: "off" },
      { host: "gateway", security: "unrestricted", ask: "off" },
      { host: "gateway", security: "full", ask: "sometimes" },
      { host: "node", security: "full", ask: "off", node: "" },
      { host: "node", security: "full", ask: "off", node: " worker-node" },
      { host: "node", security: "full", ask: "off", nodeCwd: 42 },
      { host: "node", security: "full", ask: "off", nodeCwd: "" },
      { host: "node", security: "full", ask: "off", nodeCwd: " /remote/workspace" },
    ]) {
      expectExecDeniedOrDescriptorRejected(
        withAssignment({ toolAuthority: { ...descriptor.assignment.toolAuthority, exec } }),
      );
    }
  });

  it("preserves resolved exec authority and optional fields while rejecting inherited grants", () => {
    const descriptor = launchDescriptor();
    for (const host of ["sandbox", "gateway", "node"] as const) {
      for (const security of ["deny", "allowlist", "full"] as const) {
        for (const ask of ["off", "on-miss", "always"] as const) {
          descriptor.assignment.toolAuthority.exec =
            host === "node"
              ? {
                  host,
                  security,
                  ask,
                  node: "worker-node",
                }
              : { host, security, ask };
          expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);
        }
      }
    }
    const allowedToolNames = ["read"];
    const exec = { host: "node", security: "full", ask: "off" };
    for (const [authority, expected] of [
      [{ allowedToolNames, exec: undefined }, { allowedToolNames }],
      [
        { allowedToolNames, exec: { ...exec, node: undefined, safeBins: [] } },
        { allowedToolNames, exec: { ...exec, safeBins: [] } },
      ],
      [
        {
          allowedToolNames,
          exec: Object.assign(Object.create({ node: undefined }), { ...exec, host: "gateway" }),
        },
        { allowedToolNames, exec: { ...exec, host: "gateway" } },
      ],
    ]) {
      expect(
        parseWorkerLaunchDescriptor(withAssignment({ toolAuthority: authority })).assignment
          .toolAuthority,
      ).toStrictEqual(expected);
    }
    for (const toolAuthority of [
      Object.assign(Object.create({ exec }), { allowedToolNames }),
      { allowedToolNames, exec: Object.assign(Object.create({ node: "other" }), exec) },
      { allowedToolNames, exec: Object.assign(Object.create({ safeBins: [] }), exec) },
      ...["gateway", "sandbox"].map((host) => ({
        allowedToolNames,
        exec: Object.assign(Object.create({ node: "other" }), { ...exec, host }),
      })),
    ]) {
      expectInvalidDescriptor(withAssignment({ toolAuthority }));
    }
  });

  it("accepts only a closed absolute loopback browser attachment descriptor", () => {
    const descriptor = launchDescriptor();
    descriptor.assignment.browser = {
      cdpUrl: "http://127.0.0.1:9222",
      launcherPath: "/usr/local/bin/openclaw-worker-browser",
      launcherArgs: ["literal;$(text)", "arg with spaces"],
    };
    expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);

    const browser = descriptor.assignment.browser;
    const cases: unknown[] = [
      { ...browser, unexpected: true },
      { ...browser, cdpUrl: "https://127.0.0.1:9222" },
      { ...browser, cdpUrl: "http://localhost:9222" },
      { ...browser, cdpUrl: "http://127.0.0.1" },
      { ...browser, cdpUrl: "http://127.0.0.1:9222/json/version" },
      { ...browser, launcherPath: "openclaw-worker-browser" },
      { ...browser, launcherPath: "/app\0" },
      { ...browser, launcherPath: `/${"x".repeat(4096)}` },
      { ...browser, launcherArgs: ["arg\0"] },
      { ...browser, launcherArgs: Array(33).fill("a") },
      { ...browser, launcherArgs: ["x".repeat(4097)] },
      { ...browser, launcherArgs: Array(3).fill("x".repeat(4096)) },
    ];
    for (const invalidBrowser of cases) {
      expectInvalidDescriptor(withAssignment({ browser: invalidBrowser }, descriptor));
    }
  });

  it("requires a computer descriptor and grant together and rejects target substitution fields", () => {
    const descriptor = launchDescriptor();
    descriptor.assignment.computer = {
      nodeId: "worker-desktop",
      computerUse: {
        contractVersion: 2,
        provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
        actions: ["screenshot"],
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
        features: { recording: false, agentCursor: false, multiDisplay: false },
      },
    };
    expectInvalidDescriptor(descriptor);
    descriptor.assignment.toolAuthority.allowedToolNames = ["computer"];
    descriptor.assignment.prompt = [{ type: "image", data: "AA==", mimeType: "image/png" }];
    expect(parseWorkerLaunchDescriptor(descriptor)).toEqual(descriptor);
    const { computer, ...assignmentFields } = descriptor.assignment;
    const inheritedComputerAssignment = Object.assign(
      Object.create({ computer }),
      assignmentFields,
    );
    expectInvalidDescriptor({ ...descriptor, assignment: inheritedComputerAssignment });
    const { nodeId, ...computerFields } = descriptor.assignment.computer;
    const inheritedNodeIdComputer = Object.assign(Object.create({ nodeId }), computerFields);
    for (const candidateComputer of [
      undefined,
      { ...descriptor.assignment.computer, gatewayUrl: "ws://other" },
      { ...descriptor.assignment.computer, nodeId: "" },
      inheritedNodeIdComputer,
    ]) {
      expectInvalidDescriptor(withAssignment({ computer: candidateComputer }, descriptor));
    }
  });

  it("requires admitted execution context and a bounded host-assigned agent identity", () => {
    const descriptor = launchDescriptor();
    const {
      operationalRunInstance: _operationalRunInstance,
      agentRuntimeIdentityToken: _agentRuntimeIdentityToken,
      ...legacyAssignment
    } = descriptor.assignment;

    const { agentId: _agentId, ...assignmentWithoutAgent } = descriptor.assignment;
    for (const assignment of [legacyAssignment, assignmentWithoutAgent]) {
      expectInvalidDescriptor({ ...descriptor, assignment });
    }
    for (const agentId of ["", " agent-1", "a".repeat(WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH + 1)]) {
      expectInvalidDescriptor(withAssignment({ agentId }));
    }
  });

  it("rejects unattached sessions and discontinuous event sequences", () => {
    const descriptor = launchDescriptor();
    for (const candidate of [
      { ...descriptor, admission: { ...descriptor.admission, sessionId: null } },
      { ...descriptor, admission: { ...descriptor.admission, ownerEpoch: 0 } },
      withAssignment({ liveEvents: { ackedSeq: 12, nextSeq: 14 } }),
    ]) {
      expectInvalidDescriptor(candidate);
    }
  });

  it("caps initial history at the inference context limit", () => {
    const descriptor = launchDescriptor();
    const message = descriptor.assignment.initialMessages[0];
    if (!message) {
      throw new Error("expected launch fixture message");
    }
    descriptor.assignment.initialMessages = Array.from(
      { length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES },
      () => structuredClone(message),
    );
    expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);

    descriptor.assignment.initialMessages = Array.from(
      { length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES + 1 },
      () => structuredClone(message),
    );

    expectInvalidDescriptor(descriptor);
  });
});
