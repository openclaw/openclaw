import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Explicit opt-in: ordinary CI never inspects, pulls, builds, or runs containers.
// This is scripted-provider acceptance, NOT live model/inference evidence.
const enabled = process.env.OPENCLAW_TEST_CORPORATE_DOCKER_EFFECTS === "1";

it.skipIf(!enabled)(
  "confines actual corporate Gateway tool effects with the real Docker sandbox",
  { timeout: 120_000 },
  async ({ signal }) => {
    console.info("[corporate-effect-proof] phase=case-entered");
    const { readRequestText } = await import("../../test/helpers/gateway-integration-fixtures.js");
    const { writeOpenAiResponsesText } = await import("../../test/helpers/openai-responses-sse.js");
    const { withinTest, awaitGateBeforeSettlement } = await import("../../test/helpers/promise.js");
    const { createOpenClawTestInstance } =
      await import("../../test/helpers/openclaw-test-instance.js");
    const { acquireGatewayTestClient } = await import("../../test/helpers/gateway-client.js");
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const { listKnownProviderAuthEnvVarNamesCore } =
      await import("../secrets/provider-env-vars.js");
    const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
      await import("../utils/message-channel.js");
    const { closeProvider, listenProvider, writeToolCall } =
      await import("./gateway-provider-fixture.test-support.js");
    const { buildMockOpenAiResponsesProvider } = await import("./test-openai-responses-model.js");
    const { DEFAULT_SANDBOX_IMAGE } = await import("../agents/sandbox/constants.js");
    const docker = (...args: string[]) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      }).trim();
    await using cleanup = new AsyncDisposableStack();
    // The supervised built Gateway owns its runtime outside the Vitest module graph.
    const instance = await createOpenClawTestInstance({
      name: "corporate-effects-" + randomUUID().slice(0, 8),
      signal,
      entrypoint: ["dist/index.js"],
      stopTimeoutMs: 10_000,
      env: {
        ...Object.fromEntries(
          listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
        ),
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_AGENT_RUNTIME: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
      },
    });
    cleanup.defer(() => instance.cleanup());
    console.info("[corporate-effect-proof] phase=instance-prepared");
    const state = instance.state;
    const sessionKey = `agent:main:corporate-effects-${randomUUID()}`;
    const sandboxPrefix = `oc-corp-${randomUUID().slice(0, 12)}-`;
    // The host sentinels are siblings of, never inside, the mounted workspace.
    const sentinel = await state.writeText("host-only/sentinel.txt", randomUUID());
    const originalSentinel = await fs.readFile(sentinel, "utf8");
    const escalated = state.statePath("host-only/escalated.txt");
    const signaled = state.statePath("host-only/signaled.txt");
    const processMarker = `corporate-host-process-${randomUUID()}`;
    let hostStderr = "";
    const hostProcess = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGUSR2',()=>{require('node:fs').writeFileSync(process.argv[2],'signaled');process.send('signaled')});process.send('ready');setInterval(()=>{},1000)",
        processMarker,
        signaled,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"], env: {} },
    );
    hostProcess.stderr?.on("data", (chunk: Buffer) => {
      hostStderr = (hostStderr + chunk.toString()).slice(-4096);
    });
    cleanup.defer(async () => {
      if (hostProcess.exitCode === null && hostProcess.signalCode === null) {
        const exited = once(hostProcess, "exit");
        hostProcess.kill("SIGKILL");
        await exited;
      }
    });
    expect((await withinTest(once(hostProcess, "message"), signal))[0]).toBe("ready");
    console.info("[corporate-effect-proof] phase=host-sentinel-ready");
    expect(hostProcess.pid).toBeTypeOf("number");
    // Positive control: this exact process can receive a harmless host signal.
    const hostSignal = once(hostProcess, "message");
    hostProcess.kill("SIGUSR2");
    expect(
      (
        await withinTest(
          awaitGateBeforeSettlement(
            hostSignal,
            once(hostProcess, "exit").then(() => {
              throw new Error(`Host sentinel exited: ${hostStderr}`);
            }),
            "Host sentinel exited before the positive control",
          ),
          signal,
        )
      )[0],
    ).toBe("signaled");
    expect(await fs.readFile(signaled, "utf8")).toBe("signaled");
    console.info("[corporate-effect-proof] phase=host-signal-qualified");
    await fs.unlink(signaled);

    let hostHttpHits = 0;
    const hostHttp = createServer((_request, response) => {
      hostHttpHits++;
      response.end("synthetic-host-http");
    });
    cleanup.defer(() => closeProvider(hostHttp));
    const hostUrl = (await listenProvider(hostHttp)).replace(/\/v1$/, "");
    expect(await (await fetch(hostUrl, { signal })).text()).toBe("synthetic-host-http");
    expect(hostHttpHits).toBe(1);
    console.info("[corporate-effect-proof] phase=host-http-qualified");

    // Fail setup, never silently skip an explicitly requested but unavailable backend.
    console.info("[corporate-effect-proof] phase=backend-preflight");
    docker("info", "--format", "{{.ID}}");
    console.info("[corporate-effect-proof] phase=docker-info-complete");
    docker("image", "inspect", DEFAULT_SANDBOX_IMAGE);
    console.info("[corporate-effect-proof] phase=image-inspect-complete");

    const workspaceToken = `workspace-${randomUUID()}`;
    // Python is supplied by scripts/sandbox-setup.sh's default image. No runtime
    // package installation or weakening of init/caps/rootfs/network is permitted.
    const probe = [
      "import json, os, pathlib, signal, urllib.request",
      `sentinel = ${JSON.stringify(sentinel)}`,
      `marker = ${JSON.stringify(processMarker)}`,
      "reads = []",
      "writes = []",
      "for target in [sentinel, '/proc/1/root' + sentinel]:",
      "    try:",
      "        pathlib.Path(target).read_text()",
      "        reads.append(True)",
      "    except OSError:",
      "        reads.append(False)",
      "    try:",
      "        pathlib.Path(target).write_text('unexpected sandbox host write')",
      "        writes.append(True)",
      "    except OSError:",
      "        writes.append(False)",
      "visible = []",
      "for entry in pathlib.Path('/proc').glob('[0-9]*/cmdline'):",
      "    try:",
      "        if marker in entry.read_bytes().decode(errors='replace'):",
      "            visible.append(int(entry.parent.name))",
      "    except OSError:",
      "        pass",
      // Never signal an unrelated container PID if its number happens to match
      // the host PID. A namespace regression signals only the exact owned child.
      "for pid in visible:",
      "    os.kill(pid, signal.SIGUSR2)",
      "network_reached = False",
      "try:",
      `    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(${JSON.stringify(hostUrl)}, timeout=2) as response:`,
      "        network_reached = response.read() == b'synthetic-host-http'",
      "except OSError:",
      "    pass",
      "effects = dict(host_reads=reads, host_writes=writes, host_processes=visible, host_network_reached=network_reached)",
      "pathlib.Path('effects.json').write_text(json.dumps(effects))",
      "print('CORPORATE_PROCESS_COMPLETED')",
      "print(json.dumps(effects))",
    ].join("\n");
    const steps: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "write", args: { path: "allowed.txt", content: workspaceToken } },
      { name: "read", args: { path: "allowed.txt" } },
      { name: "write", args: { path: "probe.py", content: probe } },
      { name: "exec", args: { command: "python3 /workspace/probe.py", awaitResults: true } },
      { name: "read", args: { path: sentinel } },
      { name: "write", args: { path: sentinel, content: "unexpected tool host write" } },
      {
        name: "exec",
        args: { command: `touch '${escalated}'`, host: "gateway", ask: "off" },
      },
      {
        name: "exec",
        args: { command: `touch '${escalated}'`, elevated: true, ask: "off" },
      },
    ];
    const outputs: string[] = [];
    const errors: unknown[] = [];
    let issued = 0;
    const provider = createServer((request, response) => {
      void (async () => {
        const body = JSON.parse(await readRequestText(request)) as {
          input?: Array<{ type?: string; output?: unknown }>;
        };
        if (issued > 0) {
          const output = body.input?.findLast((item) => item.type === "function_call_output");
          if (!output) {
            throw new Error("Scripted provider expected the preceding production tool result");
          }
          outputs.push(
            typeof output.output === "string" ? output.output : JSON.stringify(output.output),
          );
        }
        const step = steps[issued++];
        if (step) {
          writeToolCall(response, step.name, step.args);
        } else {
          writeOpenAiResponsesText(response, {
            text: "Corporate synthetic effect acceptance complete.",
            messageId: randomUUID(),
            responseId: randomUUID(),
          });
        }
      })().catch((error: unknown) => {
        errors.push(error);
        response.writeHead(500).end("scripted fixture failure");
      });
    });
    cleanup.defer(() => closeProvider(provider));
    const model = buildMockOpenAiResponsesProvider(
      await listenProvider(provider),
      "corporate-effects",
    );
    const cfg = {
      gateway: {
        mode: "local",
        port: instance.port,
        auth: { mode: "token", token: instance.gatewayToken },
        controlUi: { enabled: false },
      },
      security: { preset: "corporate" },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          utilityModel: "",
          sandbox: { docker: { containerPrefix: sandboxPrefix } },
          model: { primary: model.modelRef },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
        },
      },
      plugins: { enabled: false, slots: { memory: "none" } },
      skills: { load: { watch: false } },
      tools: { allow: ["read", "write", "exec"], codeMode: { enabled: false }, toolSearch: false },
    } satisfies OpenClawConfig;
    // Scope labels include workspace identity; this unique name prefix remains
    // fixture-owned even when setup fails before registry publication.
    cleanup.defer(() => {
      const ids = docker("ps", "-aq", "--filter", `name=${sandboxPrefix}`);
      if (ids) {
        docker("rm", "-f", ...ids.split(/\s+/));
      }
    });
    cleanup.defer(() => instance.stopGateway());
    await state.writeConfig(cfg);
    instance.env.OPENCLAW_GATEWAY_PORT = String(instance.port);
    console.info("[corporate-effect-proof] phase=start-cli-gateway");
    await instance.startGateway();
    const client = await acquireGatewayTestClient(
      {
        url: instance.url,
        token: instance.gatewayToken,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        requestTimeoutMs: 100_000,
        scopes: [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.pairing",
        ],
        deviceIdentity: loadOrCreateDeviceIdentity({
          path: state.statePath("proof-client", "client", "credentials.sqlite"),
        }),
      },
      {
        signal,
        timeoutMs: 15_000,
        timeoutMessage: "corporate proof client connect timeout",
        closeMessage: "corporate proof client closed",
      },
    );
    cleanup.defer(() => client.stopAndWait());
    console.info("[corporate-effect-proof] phase=dispatch-tools");
    const accepted = await client.request<{ status: string; runId: string }>("chat.send", {
      sessionKey,
      message: "Run the synthetic corporate effect acceptance sequence.",
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    expect(accepted).toMatchObject({ status: "started", runId: expect.any(String) });
    expect(
      await client.request("agent.wait", { runId: accepted.runId, timeoutMs: 90_000 }),
    ).toMatchObject({ status: "ok" });
    expect(errors).toEqual([]);
    expect(outputs).toHaveLength(steps.length);
    expect(outputs[1]).toContain(workspaceToken);
    expect(outputs[3]).toContain("CORPORATE_PROCESS_COMPLETED");
    expect(await fs.readFile(path.join(state.workspaceDir, "allowed.txt"), "utf8")).toBe(
      workspaceToken,
    );
    const effects: unknown = JSON.parse(
      await fs.readFile(path.join(state.workspaceDir, "effects.json"), "utf8"),
    );
    expect(effects).toEqual({
      host_reads: [false, false],
      host_writes: [false, false],
      host_processes: [],
      host_network_reached: false,
    });
    expect(outputs[4]).toMatch(/outside|escape|workspace|sandbox/i);
    expect(outputs[4]).not.toContain(originalSentinel);
    expect(outputs[5]).toMatch(/outside|escape|workspace|sandbox/i);
    expect(outputs[6]).toMatch(/host not allowed|requires a sandbox/i);
    expect(outputs[7]).toMatch(/elevated.*(?:not available|unavailable)/i);
    expect(await fs.readFile(sentinel, "utf8")).toBe(originalSentinel);
    expect(await fs.stat(escalated).catch(() => null)).toBeNull();
    expect(await fs.stat(signaled).catch(() => null)).toBeNull();
    expect(hostProcess.exitCode).toBeNull();
    expect(hostProcess.signalCode).toBeNull();
    expect(hostHttpHits).toBe(1);
    const history = await client.request<{ messages: unknown[] }>("chat.history", {
      sessionKey,
    });
    expect(JSON.stringify(history.messages)).toContain(
      "Corporate synthetic effect acceptance complete.",
    );
    // Supplemental backend evidence, not a substitute for the effects above.
    const ids = docker("ps", "-q", "--filter", `name=${sandboxPrefix}`);
    expect(ids).not.toBe("");
    expect(ids.split(/\s+/)).toHaveLength(1);
    const containers = JSON.parse(docker("inspect", ids)) as Array<{
      HostConfig: {
        NetworkMode: string;
        ReadonlyRootfs: boolean;
        Init: boolean;
        CapDrop: string[];
        SecurityOpt: string[];
      };
    }>;
    const policy = containers[0]?.HostConfig;
    expect(policy).toMatchObject({
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Init: true,
      CapDrop: ["ALL"],
      SecurityOpt: expect.arrayContaining(["no-new-privileges"]),
    });
    console.info(
      "[corporate-effect-proof] " +
        JSON.stringify({
          workspaceToolRead: outputs[1]?.includes(workspaceToken),
          sandboxProcess: outputs[3]?.includes("CORPORATE_PROCESS_COMPLETED"),
          effects,
          hostHttpHits,
          container: {
            network: policy?.NetworkMode,
            readOnlyRoot: policy?.ReadonlyRootfs,
            init: policy?.Init,
            capDrop: policy?.CapDrop,
            securityOpt: policy?.SecurityOpt,
          },
        }),
    );
  },
);
