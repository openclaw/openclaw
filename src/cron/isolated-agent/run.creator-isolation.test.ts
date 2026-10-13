import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { registerSandboxBackend } from "../../agents/sandbox/backend.js";
import { resolveSandboxContext } from "../../agents/sandbox/context.js";
import { hashTextSha256 } from "../../agents/sandbox/hash.js";
import { resolveSandboxRuntimeStatusAsync } from "../../agents/sandbox/runtime-status.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  assignSessionOwner,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import {
  SESSION,
  SESSION_ID,
  cfg,
  stateDir,
  inRun,
  createCronFixture,
  createCreatorTransportTools,
  installRequesterCronAuthorityTestHooks,
} from "../../gateway/server-methods/requester-cron-authority.test-support.js";
import { identifiedClient } from "../../gateway/server-methods/sessions-sharing.test-support.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { runCommandWithTimeout } from "../../process/exec-runner.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { CronService } from "../service.js";
import { createNoopLogger } from "../service.test-harness.js";
import {
  ensureAgentWorkspaceMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const session = await vi.importActual<typeof import("./session.js")>("./session.js");
const accessor = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
  "../../config/sessions/session-accessor.js",
);
installRequesterCronAuthorityTestHooks({ seedSource: false });
beforeEach(() => {
  resetRunCronIsolatedAgentTurnHarness();
  resolveCronSessionMock.mockImplementation(session.prepareCronSession);
  loadSessionEntryMock.mockImplementation(session.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
  ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({ dir }));
  resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  mockRunCronFallbackPassthrough();
});

describe("scheduled isolation is independent of creator attribution", () => {
  it.each([
    {
      name: "Lab off with B in A's ordinary source",
      via: "operator",
      requester: true,
      required: false,
      enabled: false,
    },
    {
      name: "autonomous ordinary source",
      via: "operator",
      requester: false,
      required: false,
      enabled: true,
    },
    {
      name: "B in A's ordinary source",
      via: "operator",
      requester: true,
      required: false,
      enabled: true,
    },
    {
      name: "B in A's delegated source",
      via: "spawn",
      requester: true,
      required: false,
      enabled: true,
    },
    { name: "B in A's cron source", via: "cron", requester: true, required: false, enabled: true },
    {
      name: "required source after role relaxation",
      via: "operator",
      requester: true,
      required: true,
      enabled: true,
    },
  ] as const)(
    "$name keeps A's containment through creation, reopen and real file I/O",
    async (scenario) => {
      const alice = ensureProfileForEmail("isolation-alice@example.test");
      const bob = ensureProfileForEmail("creator-bob@example.test");
      const carol = ensureProfileForEmail("assignee-carol@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      setUserProfileRole(alice.id, scenario.required ? "guest" : "maintainer");
      setUserProfileRole(bob.id, "maintainer");
      const workspace = path.join(stateDir, "workspace");
      await fs.mkdir(workspace);
      const config: OpenClawConfig = {
        ...cfg,
        agents: {
          defaults: {
            experimental: { delegatedCreatorAttribution: scenario.enabled },
            skipBootstrap: true,
            workspace,
            sandbox: {
              backend: "creator-proof",
              mode: "off",
              scope: "shared",
              workspaceAccess: "rw",
              workspaceRoot: path.join(stateDir, "sandboxes"),
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
          entries: { main: { workspace } },
        },
        tools: {
          allow: [AUTOMATIONS_TOOL_NAME, "read", "write"],
          sandbox: { tools: { allow: ["read", "write"] } },
        },
        skills: { load: { watch: false } },
        gateway: {
          roles: {
            default: "maintainer",
            definitions: {
              maintainer: {
                agents: "*",
                scopes: ["operator.admin"],
                sessions: { others: "write" },
              },
              guest: {
                agents: "*",
                scopes: ["operator.read", "operator.write"],
                sessions: { others: "view" },
                sandbox: "required",
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(config);
      const aliceActor = { type: "human", source: "profile", id: alice.id } as const;
      replaceSessionEntrySync(
        { sessionKey: SESSION },
        {
          sessionId: SESSION_ID,
          updatedAt: Date.now(),
          lifecycleRevision: "original",
          createdVia: scenario.via,
          createdActor: aliceActor,
          ...(scenario.required ? { sandbox: "required" } : {}),
        },
      );
      const fixture = createCronFixture(undefined, config);
      const definition = {
        name: "Creator is not isolation",
        enabled: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "Read the allowed file",
          toolsAllow: ["read", "write"],
        },
        delivery: { mode: "none" },
      };
      const operatorClient = identifiedClient(bob.id);
      operatorClient.connect.scopes = ["operator.admin"];
      const requester = scenario.requester
        ? await captureGatewayOperatorRunAuthority({
            client: operatorClient,
            context: fixture.context,
            sourceAuthority: { assertCurrent() {} },
          })
        : undefined;
      await inRun(
        "isolation-creator",
        undefined,
        async (_identity, admitted) => {
          bindGatewayContextResolver(admitted, () => fixture.context);
          try {
            const tools = await createCreatorTransportTools({
              transport: "embedded",
              config,
              admitted,
              senderIsOwner: true,
            });
            await tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "add", job: definition });
          } finally {
            clearGatewayContextResolver(admitted);
          }
        },
        requester?.authority,
      );
      requester?.release();
      const job = expectDefined((await fixture.read())[0], "stored job");
      expect(job.createdActor).toEqual(
        !scenario.enabled
          ? aliceActor
          : scenario.requester
            ? { type: "human", source: "profile", id: bob.id }
            : { type: "agent", id: "main" },
      );
      await fixture.context.cron.update(job.id, { name: "Edited without restamping isolation" });
      assignSessionOwner(
        { agentId: "main", sessionKey: SESSION },
        { owner: { type: "human", id: carol.id }, assignedBy: { type: "system", id: "fixture" } },
      );
      setUserProfileRole(alice.id, scenario.required ? "maintainer" : "guest");
      fixture.context.cron.stop();
      const scopes: string[] = [];
      const backendCommands: string[] = [];
      const restoreBackend = registerSandboxBackend("creator-proof", async (params) => {
        scopes.push(params.scopeKey);
        return {
          id: "creator-proof",
          runtimeId: params.scopeKey,
          runtimeLabel: "local file-boundary proof",
          workdir: params.workspaceDir,
          buildExecSpec: async () => {
            throw new Error("This fixture does not authorize model shell execution");
          },
          runShellCommand: async (command) => {
            backendCommands.push(command.script);
            const result = await runCommandWithTimeout(
              ["sh", "-c", command.script, "creator-proof", ...(command.args ?? [])],
              { timeoutMs: 10_000, signal: command.signal, input: command.stdin },
            );
            if (result.code !== 0 && !command.allowFailure) {
              throw new Error(result.stderr || "sandbox file command failed");
            }
            return {
              stdout: Buffer.from(result.stdout),
              stderr: Buffer.from(result.stderr),
              code: result.code ?? 1,
            };
          },
        };
      });
      let observed = false;
      runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
        const sessionKey = expectDefined(params.sessionKey, "execution session");
        const runtime = await resolveSandboxRuntimeStatusAsync({
          cfg: params.config,
          agentId: "main",
          sessionKey,
        });
        expect(runtime).toMatchObject({
          sandboxed: true,
          sandboxRequired: true,
          isolationSubject: { kind: "profile", profileId: alice.id },
          workspaceAccess: "ro",
        });
        const row = accessor.loadSessionEntry({ agentId: "main", sessionKey });
        expect(row?.createdActor).toEqual(job.createdActor);
        const admitted = await expectDefined(params.preparedRunAdmission, "run admission").admit(
          "gateway",
          params.runId,
        );
        const sandbox = expectDefined(
          await resolveSandboxContext({
            config: params.config,
            agentId: "main",
            sessionKey,
            workspaceDir: params.workspaceDir,
            admittedRunContext: admitted,
          }),
          "required sandbox",
        );
        await fs.writeFile(
          path.join(sandbox.workspaceDir, "allowed.txt"),
          "ALLOWED_ISOLATED_CONTENT",
        );
        const forbidden = path.join(stateDir, "forbidden.txt");
        await fs.writeFile(forbidden, "UNCHANGED_PRIVATE_CONTENT");
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey,
        });
        const bridge = expectDefined(sandbox.fsBridge, "sandbox file bridge");
        await withGatewayToolCallerIdentity(caller, async () => {
          const tools = createOpenClawCodingTools({
            config: params.config,
            agentId: "main",
            sessionKey,
            sessionId: params.sessionId,
            runId: params.runId,
            operationalRunInstance: admitted.operationalRunInstance,
            workspaceDir: params.workspaceDir,
            sandbox,
            runtimeToolAllowlist: params.toolsAllow,
            scheduledToolPolicy: params.scheduledToolPolicy,
            toolConstructionPlan: {
              includeBaseCodingTools: true,
              includeShellTools: false,
              includeChannelTools: false,
              includeOpenClawTools: false,
              includePluginTools: false,
            },
          });
          const read = expectDefined(
            tools.find((tool) => tool.name === "read"),
            "read tool",
          );
          expect(JSON.stringify(await read.execute("allowed", { path: "allowed.txt" }))).toContain(
            "ALLOWED_ISOLATED_CONTENT",
          );
          await expect(read.execute("forbidden", { path: forbidden })).rejects.toThrow(
            /outside|sandbox|escapes/i,
          );
          const before = backendCommands.length;
          await expect(
            bridge.writeFile({ filePath: "allowed.txt", data: "FORBIDDEN_WRITE" }),
          ).rejects.toThrow(/read-only/i);
          expect(backendCommands).toHaveLength(before);
          expect(await fs.readFile(path.join(sandbox.workspaceDir, "allowed.txt"), "utf8")).toBe(
            "ALLOWED_ISOLATED_CONTENT",
          );
          expect(await fs.readFile(forbidden, "utf8")).toBe("UNCHANGED_PRIVATE_CONTENT");
        });
        expect(scopes.at(-1)).toContain("principal:" + hashTextSha256(alice.id).slice(0, 32));
        observed = true;
        return { payloads: [{ text: "Read complete" }], meta: { agentMeta: {} } };
      });
      const execution = new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath: path.join(stateDir, "cron", "jobs.json"),
        cronEnabled: true,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: (request) =>
          runCronIsolatedAgentTurn({
            ...request,
            cfg: config,
            deps: {},
            agentId: "main",
            sessionKey: "cron:" + request.job.id,
          }),
      });
      try {
        await execution.start();
        await execution.run(job.id, "force");
        const outcome = execution.getJob(job.id)?.state;
        expect(outcome?.lastRunStatus, outcome?.lastError).toBe("ok");
        expect(observed).toBe(true);
      } finally {
        execution.stop();
        await execution.waitForIdle();
        restoreBackend();
      }
    },
  );
});
