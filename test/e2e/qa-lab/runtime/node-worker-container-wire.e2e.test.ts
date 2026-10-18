import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../../../../src/infra/node-commands.js";
import { resolveNodeWorkerContainerEngine } from "../../../../src/node-host/node-worker-container-engine.js";
import { createDeferred } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  type PairedNodeWorkerHost,
  type WireGateway,
  wireMessageText,
} from "./paired-node-worker-wire-fixture.js";

const execFileAsync = promisify(execFile);
const CONTAINER_WIRE_ENABLED = process.env.OPENCLAW_DOCKER_NODE_WORKER_E2E === "1";
const CONTROL_UI_PROOF_ENABLED = process.env.OPENCLAW_DOCKER_NODE_WORKER_UI_PROOF === "1";
const CONTAINER_IMAGE = process.env.OPENCLAW_DOCKER_NODE_WORKER_IMAGE ?? "node:24-bookworm";
const CONTAINER_GATEWAY_HOST =
  process.env.OPENCLAW_DOCKER_NODE_WORKER_GATEWAY_HOST ?? "host.docker.internal";
const SESSION_KEY = "agent:qa:node-worker-container-wire";
const INITIAL_MARKER = "NODE_WORKER_CONTAINER_UI_START_OK";
const INITIAL_PROMPT = `Reply with only this exact marker: ${INITIAL_MARKER}`;
const EXEC_MARKER = "NODE_WORKER_CONTAINER_YOLO_OK";
const EXEC_FILE = "node-worker-container-yolo.txt";
const EXEC_COMMAND = `test -f /.dockerenv && printf ${EXEC_MARKER} > ${EXEC_FILE} && sleep 1`;
const PROMPT = `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`${EXEC_COMMAND}\`. After that exec command completes or fails, reply exactly \`${EXEC_MARKER}\`.`;
const CANCEL_STARTED_FILE = "node-worker-container-cancel-started.txt";
const CANCEL_LATE_FILE = "node-worker-container-cancel-late.txt";
const CANCEL_COMMAND = `test -f /.dockerenv && printf started > ${CANCEL_STARTED_FILE} && sleep 30 && printf escaped > ${CANCEL_LATE_FILE}`;
const CANCEL_PROMPT = `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`${CANCEL_COMMAND}\`. After that exec command completes or fails, reply exactly \`NODE_WORKER_CANCELLED\`.`;
const RECOVERY_MARKER = "NODE_WORKER_CONTAINER_CANCEL_RECOVERED";
const RECOVERY_PROMPT = `Reply with only this exact marker: ${RECOVERY_MARKER}`;
const CONTAINER_INSPECT_FORMAT =
  '{"mounts":{{json .Mounts}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"labels":{{json .Config.Labels}}}';

type ObservedWorkerContainer = {
  id: string;
  image: string;
  state: string;
  labels: Record<string, string>;
  mounts: Array<{ Source: string; Destination: string; RW: boolean }>;
};

type WireRequest = {
  method: string;
  params?: {
    key?: string;
    agentId?: string;
    deviceId?: string;
    message?: string;
    idempotencyKey?: string;
    runId?: string;
    sessionKey?: string;
    permissionMode?: string;
  };
};
type ControlUiProof = Awaited<ReturnType<typeof startControlUiProof>>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const waitForProof = (callback: () => unknown, interval = 100) =>
  vi.waitFor(callback, { timeout: PROOF_TIMEOUT_MS, interval });
const launchFilter = (launchId: string) =>
  `label=openclaw.node-worker.launch=${Buffer.from(launchId).toString("base64url")}`;

async function dockerOutput(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    encoding: "utf8",
    timeout: 15_000,
  });
  return stdout.trim();
}

const containerIds = (filter: string) =>
  dockerOutput(["ps", "-aq", "--no-trunc", "--filter", filter]);

async function expectAssistantMarker(operator: GatewayClient, sessionKey: string, marker: string) {
  const history = await operator.request<{ messages?: unknown[] }>("chat.history", {
    sessionKey,
    limit: 20,
  });
  expect(
    history.messages?.some(
      (message) =>
        (message as { role?: unknown }).role === "assistant" &&
        wireMessageText(message).includes(marker),
    ),
  ).toBe(true);
}

async function sendUiMessage(proof: ControlUiProof, message: string) {
  await proof.page.locator(".agent-chat__composer-combobox textarea").fill(message);
  await proof.page.getByRole("button", { name: "Send message" }).click();
}

async function expectNoApprovalUi(proof: ControlUiProof) {
  expect(await proof.page.locator("[data-approval-id], .exec-approval-modal-stack").count()).toBe(
    0,
  );
}

async function observeWorkerContainer(launchId: string): Promise<ObservedWorkerContainer> {
  let observed: ObservedWorkerContainer | undefined;
  await vi.waitFor(
    async () => {
      const id = await containerIds(launchFilter(launchId));
      expect(id).toMatch(/^[a-f0-9]{64}$/u);
      const metadata = JSON.parse(
        await dockerOutput(["inspect", "--format", CONTAINER_INSPECT_FORMAT, id]),
      ) as Omit<ObservedWorkerContainer, "id">;
      expect(["created", "running"]).toContain(metadata.state);
      observed = { id, ...metadata };
    },
    { timeout: 30_000, interval: 50 },
  );
  if (!observed) {
    throw new Error("Docker worker container was never observed");
  }
  return observed;
}

async function startControlUiProof(gateway: WireGateway) {
  await vi.waitFor(
    async () => {
      const response = await fetch(`${gateway.baseUrl}/new`);
      expect(response.status, await response.text()).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    },
    { timeout: 60_000, interval: 250 },
  );
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  await context.addInitScript(
    ({ gatewayUrl, token }) => {
      Object.defineProperty(globalThis, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {
        configurable: true,
        value: { gatewayUrl, token },
      });
    },
    { gatewayUrl: gateway.wsUrl, token: gateway.token },
  );
  let patchSessionKey: string | undefined;
  let releaseHeldPatch: (() => void) | undefined;
  const requests: WireRequest[] = [];
  const patchHeld = createDeferred();
  const prematureChatSend = createDeferred<"premature-chat-send">();
  await context.routeWebSocket(gateway.wsUrl, (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const request = JSON.parse(message.toString()) as Partial<WireRequest>;
      if (
        request.method === "sessions.create" ||
        request.method === "sessions.dispatch" ||
        request.method === "sessions.send" ||
        request.method === "chat.send" ||
        request.method === "chat.abort"
      ) {
        requests.push({ method: request.method, params: request.params });
      }
      if (
        request.method === "sessions.patch" &&
        patchSessionKey !== undefined &&
        request.params?.key === patchSessionKey &&
        request.params?.permissionMode === "full"
      ) {
        patchSessionKey = undefined;
        releaseHeldPatch = () => {
          releaseHeldPatch = undefined;
          upstream.send(message);
        };
        patchHeld.resolve();
        return;
      }
      if (releaseHeldPatch && request.method === "chat.send") {
        prematureChatSend.resolve("premature-chat-send");
      }
      upstream.send(message);
    });
  });
  return {
    browser,
    page: await context.newPage(),
    requests,
    fullAccessPatch: {
      arm: (sessionKey: string) => {
        patchSessionKey = sessionKey;
      },
      held: patchHeld.promise,
      prematureChatSend: prematureChatSend.promise,
      release: () => releaseHeldPatch?.(),
    },
  };
}

it.runIf(CONTAINER_WIRE_ENABLED)(
  "runs a full-access remote turn in Docker without producing approval requests",
  { timeout: PROOF_TIMEOUT_MS + 120_000 },
  async () => {
    const root = tempDirs.make("openclaw-node-worker-container-wire-");
    const provider = await startQaMockOpenAiServer({ modelRefs: [MODEL_REF] });
    const published = await createPublishedWireWorkspace(root);
    const engine = await resolveNodeWorkerContainerEngine();
    const approvalEvents: string[] = [];
    const gatewayOwner = createQaGatewayChild();
    let gateway: WireGateway | undefined;
    let operator: GatewayClient | undefined;
    let workerNode: PairedNodeWorkerHost | undefined;
    let observedContainer: Promise<ObservedWorkerContainer> | undefined;
    let controlUiProof: ControlUiProof | undefined;
    let browserRunId: string | undefined;
    let launchId: string | undefined;
    let inspectLaunchedContainer = !CONTROL_UI_PROOF_ENABLED;
    let releasePendingCancellation: (() => void) | undefined;
    let sessionKey = SESSION_KEY;

    const runProof = async () => {
      expect(engine.id).toBe("docker");
      gateway = await startPairedNodeWorkerGateway({
        owner: gatewayOwner,
        providerBaseUrl: provider.baseUrl,
        fullAccess: true,
        useRepoCli: false,
        ...(CONTROL_UI_PROOF_ENABLED
          ? { controlUiEnabled: true, workspaceDir: published.source }
          : {}),
      });
      operator = await connectWireClient({
        gateway,
        role: "operator",
        identity: null,
        includeApprovals: true,
        onEvent: (event) => {
          if (event.event.endsWith(".approval.requested")) {
            approvalEvents.push(event.event);
          }
          if (event.event === "chat") {
            const payload = event.payload as { runId?: unknown; sessionKey?: unknown } | undefined;
            if (payload?.sessionKey === sessionKey && typeof payload.runId === "string") {
              browserRunId = payload.runId;
            }
          }
        },
      });
      const waitForRun = (runId: string | undefined) =>
        operator!.request<{ status?: string }>(
          "agent.wait",
          { runId, timeoutMs: PROOF_TIMEOUT_MS },
          { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
        );
      const describeSession = () =>
        gateway!.call("sessions.describe", { key: sessionKey }) as Promise<{
          session?: {
            execCwd?: string;
            spawnedCwd?: string;
            placement?: { state?: string; remoteWorkspaceDir?: string };
          };
        }>;

      const initialApprovals = await operator.request<{ hash: string }>("exec.approvals.get", {});
      await operator.request("exec.approvals.set", {
        baseHash: initialApprovals.hash,
        file: {
          version: 1,
          defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
        },
      });

      const workerGatewayUrl = new URL(gateway.wsUrl);
      workerGatewayUrl.hostname = CONTAINER_GATEWAY_HOST;
      workerNode = await createPairedNodeWorkerHost({
        gateway,
        operator,
        root,
        containerEngine: engine,
        containerImage: CONTAINER_IMAGE,
        workerGatewayUrl: workerGatewayUrl.toString(),
        workerEnv: { OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
        onInvoke: (frame) => {
          if (frame.command !== NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND || !frame.paramsJSON) {
            return;
          }
          launchId = (JSON.parse(frame.paramsJSON) as { launchId?: string }).launchId;
          if (launchId && inspectLaunchedContainer) {
            observedContainer = observeWorkerContainer(launchId);
          }
        },
      });

      let remoteWorkspaceDir: string | undefined;
      if (CONTROL_UI_PROOF_ENABLED) {
        controlUiProof = await startControlUiProof(gateway);
        await controlUiProof.page.goto(`${gateway.baseUrl}/new`);
        const where = controlUiProof.page.locator("#new-session-where-trigger");
        await where.waitFor({ state: "visible", timeout: 60_000 });
        await where.click();
        const device = controlUiProof.page.locator(
          `[data-value="device:${workerNode.identity.deviceId}"]`,
        );
        await device.waitFor({ state: "visible", timeout: 30_000 });
        expect(await device.isEnabled()).toBe(true);
        await device.click();
        await expect
          .poll(() => where.getAttribute("data-device-id"))
          .toBe(workerNode.identity.deviceId);
        await controlUiProof.page.locator(".new-session-page__message").fill(INITIAL_PROMPT);
        await controlUiProof.page.getByRole("button", { name: "Start session" }).click();
        await waitForProof(() =>
          expect(controlUiProof!.requests.map((request) => request.method)).toEqual([
            "sessions.create",
            "sessions.dispatch",
            "sessions.send",
          ]),
        );
        const [created, dispatched, sent] = controlUiProof.requests;
        expect(created?.params).toMatchObject({ agentId: "qa" });
        expect(dispatched?.params).toMatchObject({
          agentId: "qa",
          deviceId: workerNode.identity.deviceId,
        });
        expect(dispatched?.params?.key).toMatch(/^agent:qa:/u);
        sessionKey = dispatched!.params!.key!;
        expect(sent?.params).toMatchObject({
          key: sessionKey,
          agentId: "qa",
          message: INITIAL_PROMPT,
        });
        const initialRunId = sent?.params?.idempotencyKey;
        expect(initialRunId).toBeTruthy();
        await waitForProof(() => expect(launchId).toBeTruthy());
        await expect(waitForRun(initialRunId)).resolves.toMatchObject({ status: "ok" });
        const firstLaunchId = launchId;
        expect(firstLaunchId).toBeTruthy();
        await workerNode.waitForWorkersIdle();
        await expect(containerIds(launchFilter(firstLaunchId!))).resolves.toBe("");
        await expectAssistantMarker(operator, sessionKey, INITIAL_MARKER);
        const described = await describeSession();
        expect(described.session?.placement).toMatchObject({ state: "active" });
        remoteWorkspaceDir = described.session?.placement?.remoteWorkspaceDir;
        launchId = undefined;
        observedContainer = undefined;
        browserRunId = undefined;
        inspectLaunchedContainer = true;
      } else {
        await operator.request("sessions.create", {
          key: sessionKey,
          agentId: "qa",
          worktree: true,
          worktreeName: "node-worker-container-wire",
          worktreeBaseRef: "main",
          cwd: published.source,
          permissionMode: "full",
        });
        const dispatched = (await gateway.call(
          "sessions.dispatch",
          { key: sessionKey, deviceId: workerNode.identity.deviceId },
          { timeoutMs: PROOF_TIMEOUT_MS },
        )) as { placement?: { state?: string; remoteWorkspaceDir?: string } };
        expect(dispatched.placement).toMatchObject({ state: "active" });
        remoteWorkspaceDir = dispatched.placement?.remoteWorkspaceDir;
      }
      expect(remoteWorkspaceDir).toBeTruthy();

      if (controlUiProof) {
        const sessionPath = buildControlUiSessionPath({
          namespace: "chat",
          sessionKey,
          fallbackAgentId: "qa",
        });
        await controlUiProof.page.goto(`${gateway.baseUrl}${sessionPath}`);
        const permission = controlUiProof.page.locator('[data-chat-permission-select="true"]');
        await permission.waitFor({ state: "visible", timeout: 60_000 });
        await controlUiProof.page.locator(".agent-chat__composer-combobox textarea").fill(PROMPT);
        controlUiProof.fullAccessPatch.arm(sessionKey);
        await permission.click();
        await controlUiProof.page.locator('[data-chat-permission-option="full"]').click();
        await controlUiProof.fullAccessPatch.held;
        await controlUiProof.page.getByRole("button", { name: "Send message" }).click();
        const sendOrdering = await Promise.race([
          controlUiProof.fullAccessPatch.prematureChatSend,
          controlUiProof.page
            .locator(".chat-queue")
            .getByText("Applying chat settings")
            .waitFor({ state: "visible", timeout: 30_000 })
            .then(() => "queued-behind-settings" as const),
        ]);
        expect(sendOrdering).toBe("queued-behind-settings");
        controlUiProof.fullAccessPatch.release();
        await expect.poll(() => permission.getAttribute("data-chat-select-value")).toBe("full");
        const activeOperator = operator;
        await waitForProof(async () => {
          expect(launchId).toBeTruthy();
          expect(browserRunId).toBeTruthy();
          await expectAssistantMarker(activeOperator, sessionKey, EXEC_MARKER);
        }, 250);
        await expect(waitForRun(browserRunId)).resolves.toMatchObject({ status: "ok" });
        await controlUiProof.page
          .locator(".chat-group.assistant")
          .getByText(EXEC_MARKER, { exact: true })
          .last()
          .waitFor({ state: "visible", timeout: PROOF_TIMEOUT_MS });
        await expectNoApprovalUi(controlUiProof);
      } else {
        const runId = `node-worker-container-yolo-${Date.now()}`;
        await expect(
          operator.request("chat.send", {
            sessionKey,
            message: PROMPT,
            deliver: false,
            idempotencyKey: runId,
          }),
        ).resolves.toMatchObject({ runId, status: "started" });
        await expect(waitForRun(runId)).resolves.toMatchObject({ status: "ok" });
      }

      expect(launchId).toBeTruthy();
      expect(observedContainer).toBeTruthy();
      const container = await observedContainer!;
      expect(container.image).toBe(CONTAINER_IMAGE);
      expect(container.mounts).toHaveLength(2);
      expect(container.mounts).toContainEqual(
        expect.objectContaining({
          Source: remoteWorkspaceDir,
          Destination: remoteWorkspaceDir,
          RW: true,
        }),
      );
      expect(container.mounts.filter((mount) => !mount.RW)).toHaveLength(1);
      expect(container.labels["openclaw.node-worker.launch"]).toBe(
        Buffer.from(launchId!).toString("base64url"),
      );
      await expect(fs.readFile(path.join(remoteWorkspaceDir!, EXEC_FILE), "utf8")).resolves.toBe(
        EXEC_MARKER,
      );

      const described = await describeSession();
      const gatewayWorkspaceDir = described.session?.execCwd ?? described.session?.spawnedCwd;
      expect(gatewayWorkspaceDir).toBeTruthy();
      await expect(fs.readFile(path.join(gatewayWorkspaceDir!, EXEC_FILE), "utf8")).resolves.toBe(
        EXEC_MARKER,
      );
      await expectAssistantMarker(operator, sessionKey, EXEC_MARKER);
      if (controlUiProof) {
        const cancellationEntered = createDeferred();
        const continueCancellation = createDeferred();
        releasePendingCancellation = () => continueCancellation.resolve();
        const originalCancel = workerNode.supervisor.cancel.bind(workerNode.supervisor);
        vi.spyOn(workerNode.supervisor, "cancel").mockImplementation(async (...args) => {
          cancellationEntered.resolve();
          await continueCancellation.promise;
          return await originalCancel(...args);
        });

        const previousLaunchId = launchId;
        browserRunId = undefined;
        await sendUiMessage(controlUiProof, CANCEL_PROMPT);
        await waitForProof(() => {
          expect(launchId).toBeTruthy();
          expect(launchId).not.toBe(previousLaunchId);
          expect(browserRunId).toBeTruthy();
        });
        const cancelledLaunchId = launchId!;
        const cancelledRunId = browserRunId!;
        const cancelledContainer = await observedContainer!;
        await waitForProof(async () =>
          expect(
            await fs.readFile(path.join(remoteWorkspaceDir!, CANCEL_STARTED_FILE), "utf8"),
          ).toBe("started"),
        );

        await controlUiProof.page.getByRole("button", { name: "Stop generating" }).click();
        await cancellationEntered.promise;
        expect(controlUiProof.requests.at(-1)).toMatchObject({
          method: "chat.abort",
          params: { sessionKey, runId: cancelledRunId },
        });
        await expect(workerNode.supervisor.status(cancelledLaunchId)).resolves.toMatchObject({
          state: "running",
        });

        await sendUiMessage(controlUiProof, RECOVERY_PROMPT);
        const recoveryRequest = controlUiProof.requests.at(-1);
        expect(recoveryRequest).toMatchObject({
          method: "chat.send",
          params: { sessionKey, message: RECOVERY_PROMPT },
        });
        const recoveryRunId = recoveryRequest?.params?.idempotencyKey;
        expect(recoveryRunId).toBeTruthy();
        await controlUiProof.page.getByRole("button", { name: "Stop generating" }).waitFor();
        releasePendingCancellation();
        releasePendingCancellation = undefined;
        await expect(waitForRun(recoveryRunId)).resolves.toMatchObject({ status: "ok" });
        await workerNode.waitForWorkersIdle();
        await expect(workerNode.supervisor.status(cancelledLaunchId)).resolves.toMatchObject({
          state: "cancelled",
        });
        await expect(containerIds(`id=${cancelledContainer.id}`)).resolves.toBe("");
        await expect(fs.stat(path.join(remoteWorkspaceDir!, CANCEL_LATE_FILE))).rejects.toThrow();
        await expectAssistantMarker(operator, sessionKey, RECOVERY_MARKER);
        await expectNoApprovalUi(controlUiProof);
      }
      await expect(operator.request("exec.approval.list", {})).resolves.toEqual([]);
      expect(approvalEvents).toEqual([]);
      await workerNode.waitForInvokes();
      expect(workerNode.invokeErrors).toEqual([]);
      await workerNode.waitForWorkersIdle();
      await expect(containerIds(`id=${container.id}`)).resolves.toBe("");
    };
    await runQaGatewayFixture(
      runProof,
      () => releasePendingCancellation?.(),
      () => controlUiProof?.fullAccessPatch.release(),
      async () => controlUiProof?.browser.close(),
      async () => {
        const cleanup = await Promise.allSettled([
          workerNode?.stop() ?? Promise.resolve(),
          operator?.stopAndWait({ timeoutMs: 2_000 }) ?? Promise.resolve(),
          stopQaGatewayFixture(gatewayOwner),
          provider.stop(),
          closeWireServer(published.server),
        ]);
        const failures = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "node worker container wire cleanup failed");
        }
      },
    );
  },
);
