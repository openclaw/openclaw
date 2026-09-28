import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  captureCronRequesterGrantIssuer,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../agents/cron-creator-authority-context.js";
import {
  consumeCronCreatorAuthorityGrant,
  resolveCronCreatorAuthorityGrantProvenance,
} from "../gateway/cron-creator-authority-grant.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "../gateway/mcp-grant-store.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";
import type { CronJobCreate, CronJobPatch, CronToolsAllowProvenance } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-channel-requester-",
});

function createCronService(storePath: string) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: false,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

const requesterOwner = {
  agentId: "ops",
  sessionKey: "agent:ops:discord:group:ops",
  accountId: "work",
};
const requesterPolicy = {
  version: 1 as const,
  mode: "account" as const,
  ownerSessionKey: requesterOwner.sessionKey,
  ownerAccountId: requesterOwner.accountId,
};
const channelRequester = {
  version: 1 as const,
  channel: "discord",
  accountId: requesterOwner.accountId,
  senderId: "requester-a",
};
const fullRequesterProvenance: CronToolsAllowProvenance = {
  version: 1,
  source: "final-executable-surface",
  callerOrigin: { kind: "unknown" },
  channelRequester,
};
const localProvenance: CronToolsAllowProvenance = {
  version: 1,
  source: "authenticated-requester",
  callerOrigin: { kind: "local" },
};

function requesterDeclaration(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "daily report",
    declarationKey: "agent:ops:daily-report",
    displayName: "Daily report",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    owner: requesterOwner,
    sessionKey: requesterOwner.sessionKey,
    payload: { kind: "agentTurn", message: "report", toolsAllow: ["message"] },
    delivery: { mode: "none" },
    ...overrides,
  };
}

describe("CronService authenticated channel requester", () => {
  it("rejects a minted requester token at commit after its MCP capture is deactivated", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    const runId = "cron-requester-mcp-commit";
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        runId,
        agentId: requesterOwner.agentId,
        ingress: { kind: "system", boundary: "cron-requester-mcp-test", state: "present" },
      },
    });
    let loopbackToken: string | undefined;
    try {
      const admitted = await admission.admit("gateway", `gateway-${runId}`);
      const delegatedAuthority = expectDefined(
        getAdmittedRunDelegatedAuthority(admitted),
        "live delegated authority",
      );
      const creator = expectDefined(
        createCronCreatorAuthorityCapability(
          runId,
          { kind: "external", channel: channelRequester.channel },
          undefined,
          undefined,
          channelRequester,
        ),
        "native creator scope",
      );
      await runWithCronCreatorAuthorityCapability(creator, async () => {
        const loopback = mintMcpLoopbackClientGrant({
          context: {
            sessionKey: requesterOwner.sessionKey,
            agentId: requesterOwner.agentId,
            runId,
            accountId: requesterOwner.accountId,
            messageProvider: channelRequester.channel,
            senderIsOwner: false,
          },
          runtimeOwnerToken: "cron-requester-mcp-commit-runtime",
          admittedRunContext: admitted,
          cronRequesterGrantIssuer: expectDefined(
            captureCronRequesterGrantIssuer(runId),
            "native requester issuer",
          ),
        });
        loopbackToken = loopback.token;
        const capture = {
          token: loopback.token,
          runtimeOwnerToken: "cron-requester-mcp-commit-runtime",
          captureKey: "cron-requester-capture",
        };
        expect(activateMcpLoopbackClientGrantCapture(capture)).toBeTruthy();
        const resolved = expectDefined(resolveMcpLoopbackClientGrant(capture), "active MCP grant");
        const requesterGrant = expectDefined(resolved.mintCronRequesterGrant, "requester minter")();
        const requester = expectDefined(
          resolveCronCreatorAuthorityGrantProvenance(requesterGrant, runId)?.channelRequester,
          "captured native requester",
        );
        const toolsAllowProvenance: CronToolsAllowProvenance = {
          version: 1,
          source: "authenticated-requester",
          channelRequester: requester,
        };
        const commitGuard = vi.fn(() => {
          consumeCronCreatorAuthorityGrant(requesterGrant);
        });

        expect(deactivateMcpLoopbackClientGrantCapture(capture)).toBe(true);
        expect(creator.active).toBe(true);
        expect(creator.signal.aborted).toBe(false);
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(delegatedAuthority);
        await expect(
          cron.add(requesterDeclaration(), {
            scheduledToolPolicy: requesterPolicy,
            toolsAllowProvenance,
            commitGuard,
          }),
        ).rejects.toThrow("Configured MCP cron authority is no longer active");
        expect(commitGuard).toHaveBeenCalledOnce();
        expect((await loadCronStore(storePath)).jobs).toEqual([]);

        expect(activateMcpLoopbackClientGrantCapture(capture)).toBeTruthy();
        const current = expectDefined(
          resolveMcpLoopbackClientGrant(capture),
          "reactivated MCP grant",
        );
        const freshGrant = expectDefined(
          current.mintCronRequesterGrant,
          "fresh requester minter",
        )();
        const created = await cron.add(requesterDeclaration(), {
          scheduledToolPolicy: requesterPolicy,
          toolsAllowProvenance,
          commitGuard: () => {
            consumeCronCreatorAuthorityGrant(freshGrant);
          },
        });
        expect((await loadCronStore(storePath)).jobs).toMatchObject([
          { id: created.id, toolsAllowProvenance },
        ]);
      });
    } finally {
      if (loopbackToken) {
        revokeMcpLoopbackClientGrant(loopbackToken);
      }
      admission.close();
      cron.stop();
    }
  });

  it.each(["authenticated-requester", "final-executable-surface"] as const)(
    "persists and rebinds a finite native requester cap with %s provenance",
    async (source) => {
      const { storePath } = await makeStorePath();
      const cron = createCronService(storePath);
      const provenance: CronToolsAllowProvenance =
        source === "final-executable-surface"
          ? fullRequesterProvenance
          : { version: 1, source, channelRequester };
      try {
        const created = await cron.add(requesterDeclaration(), {
          scheduledToolPolicy: requesterPolicy,
          toolsAllowProvenance: provenance,
          createdActor: { type: "human", source: "profile", id: "original-session-creator" },
        });
        const stored = (await loadCronStore(storePath)).jobs[0]!;
        expect(stored.toolsAllowProvenance).toEqual(provenance);
        expect(stored.payload.toolsAllow).toEqual(["message"]);
        expect(stored.payload.toolsAllowIsDefault).toBeUndefined();

        const nextRequester = { ...channelRequester, senderId: "requester-b" };
        await cron.update(
          created.id,
          { name: "Updated executable instructions" },
          {
            toolsAllowProvenance: {
              version: 1,
              source: "authenticated-requester",
              channelRequester: nextRequester,
            },
          },
        );
        const rebound = (await loadCronStore(storePath)).jobs[0]!;
        expect(rebound.toolsAllowProvenance).toEqual({
          ...provenance,
          channelRequester: nextRequester,
        });
        expect(rebound.owner).toEqual(requesterOwner);
        expect(rebound.scheduledToolPolicy).toEqual(requesterPolicy);
        expect(rebound.payload.toolsAllow).toEqual(["message"]);
        expect(rebound.createdActor?.id).toBe("original-session-creator");

        await cron.update(created.id, {
          payload: { kind: "agentTurn", message: "New instructions without a native capture" },
        });
        expect((await loadCronStore(storePath)).jobs[0]?.toolsAllowProvenance).toEqual(
          source === "final-executable-surface"
            ? { version: 1, source, callerOrigin: { kind: "unknown" } }
            : undefined,
        );
      } finally {
        cron.stop();
      }
    },
  );

  it.each<{
    name: string;
    patch: CronJobPatch;
    preserves: boolean;
    trigger?: CronJobCreate["trigger"];
    freshRequester?: boolean;
  }>([
    { name: "model-visible name", patch: { name: "Run different instructions" }, preserves: false },
    {
      name: "model selection",
      patch: { payload: { kind: "agentTurn", model: "openai/test-model" } },
      preserves: false,
    },
    {
      name: "schedule",
      patch: { schedule: { kind: "every", everyMs: 120_000 } },
      preserves: false,
    },
    {
      name: "delivery target",
      patch: { delivery: { to: "channel:another", accountId: "work" } },
      preserves: false,
    },
    {
      name: "trigger program",
      patch: { trigger: { script: "return { fire: true }" } },
      preserves: false,
    },
    {
      name: "authored trigger input",
      patch: { state: { triggerState: { destination: "another" } } },
      preserves: false,
      trigger: { script: "return { fire: true }" },
    },
    {
      name: "display metadata and runtime progress",
      patch: {
        description: "More context for the operator",
        displayName: "Daily summary",
        state: { lastRunAtMs: 1234, consecutiveErrors: 1 },
      },
      preserves: true,
      freshRequester: true,
    },
    {
      name: "equivalent executable resave",
      patch: { name: "daily report", payload: { kind: "agentTurn", message: "report" } },
      preserves: true,
      freshRequester: true,
    },
  ])("reconciles requester authority for $name", async (testCase) => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    try {
      const created = await cron.add(requesterDeclaration({ trigger: testCase.trigger }), {
        scheduledToolPolicy: requesterPolicy,
        toolsAllowProvenance: fullRequesterProvenance,
      });
      await cron.update(
        created.id,
        testCase.patch,
        testCase.freshRequester
          ? {
              toolsAllowProvenance: {
                version: 1,
                source: "authenticated-requester",
                channelRequester: { ...channelRequester, senderId: "requester-b" },
              },
            }
          : undefined,
      );
      const stored = (await loadCronStore(storePath)).jobs[0]!;
      expect(stored.toolsAllowProvenance).toEqual({
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "unknown" },
        ...(testCase.preserves ? { channelRequester } : {}),
      });
      expect(stored.scheduledToolPolicy).toEqual(requesterPolicy);
      expect(stored.payload.toolsAllow).toEqual(["message"]);
    } finally {
      cron.stop();
    }
  });

  it.each(["update", "declaration"] as const)(
    "captures the native requester during %s without clearing captured harness authority",
    async (mutation) => {
      const { storePath } = await makeStorePath();
      const cron = createCronService(storePath);
      const input = requesterDeclaration();
      const runtimeAuthority = {
        version: 1 as const,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      };
      const commitGuard = vi.fn();
      const toolsAllowProvenance: CronToolsAllowProvenance = {
        version: 1,
        source: "authenticated-requester",
        channelRequester,
      };
      try {
        const created = await cron.add(input, {
          scheduledToolPolicy: requesterPolicy,
          toolsAllowProvenance: {
            version: 1,
            source: "final-executable-surface",
            callerOrigin: { kind: "unknown" },
          },
          captureRuntimeAuthority: () => runtimeAuthority,
        });
        const repeat = () =>
          cron.add(
            { ...input, payload: { kind: "agentTurn", message: "updated report" } },
            { toolsAllowProvenance, commitGuard },
          );
        if (mutation === "update") {
          await cron.update(
            created.id,
            { payload: { kind: "agentTurn", message: "updated report" } },
            { toolsAllowProvenance, commitGuard },
          );
        } else {
          expect(await repeat()).toMatchObject({
            id: created.id,
            created: false,
            updated: true,
          });
          expect(await repeat()).toMatchObject({
            id: created.id,
            created: false,
            updated: false,
          });
        }
        expect(commitGuard).toHaveBeenCalledTimes(mutation === "update" ? 1 : 2);
        const stored = (await loadCronStore(storePath)).jobs[0]!;
        expect(stored.toolsAllowProvenance).toEqual(fullRequesterProvenance);
        expect(stored.runtimeAuthority).toEqual(runtimeAuthority);
        expect(stored.runtimeAuthorityRecoveryRequired).toBeUndefined();
        expect(stored.payload.toolsAllow).toEqual(["message"]);
      } finally {
        cron.stop();
      }
    },
  );

  it.each(["update", "declaration"] as const)(
    "keeps native requester facts within the job account during %s",
    async (mutation) => {
      const { storePath } = await makeStorePath();
      const cron = createCronService(storePath);
      const input = requesterDeclaration();
      try {
        const created = await cron.add(input, {
          scheduledToolPolicy: requesterPolicy,
          toolsAllowProvenance: fullRequesterProvenance,
        });
        const options = {
          toolsAllowProvenance: {
            version: 1 as const,
            source: "authenticated-requester" as const,
            channelRequester: { ...channelRequester, accountId: "another-account" },
          },
        };
        if (mutation === "update") {
          await cron.update(created.id, { name: "Updated report" }, options);
        } else {
          await cron.add(
            { ...input, payload: { kind: "agentTurn", message: "Updated report" } },
            options,
          );
        }
        const stored = (await loadCronStore(storePath)).jobs[0]!;
        expect(stored.toolsAllowProvenance?.channelRequester).toBeUndefined();
        expect(stored.toolsAllowProvenance?.source).toBe("final-executable-surface");
        expect(stored.scheduledToolPolicy).toEqual(requesterPolicy);
      } finally {
        cron.stop();
      }
    },
  );

  it.each([
    { mutation: "update", mode: "account" },
    { mutation: "update", mode: "trusted" },
    { mutation: "declaration", mode: "account" },
    { mutation: "declaration", mode: "trusted" },
  ] as const)(
    "preserves $mode policy across operator tool-runtime transitions through $mutation",
    async ({ mutation, mode }) => {
      const { storePath } = await makeStorePath();
      const cron = createCronService(storePath);
      const input = requesterDeclaration();
      try {
        const created = await cron.add(
          input,
          mode === "account"
            ? {
                scheduledToolPolicy: requesterPolicy,
                toolsAllowProvenance: fullRequesterProvenance,
              }
            : undefined,
        );
        const command: CronJobCreate["payload"] = {
          kind: "command",
          argv: ["true"],
        };
        if (mutation === "update") {
          await cron.update(created.id, { payload: command });
        } else {
          await cron.add({ ...input, payload: { ...command, toolsAllow: ["message"] } });
        }
        const dormant = (await loadCronStore(storePath)).jobs[0]!;
        expect(dormant.scheduledToolPolicy).toEqual(
          mode === "account" ? requesterPolicy : undefined,
        );
        expect(dormant.toolsAllowProvenance?.channelRequester).toBeUndefined();

        if (mutation === "update") {
          await cron.update(created.id, { payload: { kind: "agentTurn", message: "report" } });
        } else {
          await cron.add(input);
        }
        const restored = (await loadCronStore(storePath)).jobs[0]!;
        expect(restored.scheduledToolPolicy).toEqual(
          mode === "account" ? requesterPolicy : { version: 1, mode: "trusted" },
        );
        expect(restored.toolsAllowProvenance?.channelRequester).toBeUndefined();
        expect(restored.payload.toolsAllow).toEqual(["message"]);
      } finally {
        cron.stop();
      }
    },
  );
});

describe("CronService authenticated caller origin", () => {
  it("persists local creation, clears executable edits, and permits explicit reauthorization", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    try {
      const created = await cron.add(requesterDeclaration({ declarationKey: undefined }), {
        scheduledToolPolicy: requesterPolicy,
        toolsAllowProvenance: localProvenance,
      });
      expect(created.toolsAllowProvenance).toEqual(localProvenance);

      await cron.update(created.id, {
        description: "descriptive only",
        displayName: "Daily report metadata",
      });
      expect((await loadCronStore(storePath)).jobs[0]?.toolsAllowProvenance).toEqual(
        localProvenance,
      );

      await cron.update(created.id, {
        payload: { kind: "agentTurn", toolsAllow: ["message"] },
      });
      expect((await loadCronStore(storePath)).jobs[0]?.toolsAllowProvenance).toEqual(
        localProvenance,
      );

      await cron.update(created.id, { name: "Changed model context" });
      expect((await loadCronStore(storePath)).jobs[0]?.toolsAllowProvenance).toBeUndefined();

      await cron.update(
        created.id,
        { payload: { kind: "agentTurn", toolsAllow: ["message"] } },
        { toolsAllowProvenance: localProvenance },
      );
      expect((await loadCronStore(storePath)).jobs[0]?.toolsAllowProvenance).toEqual(
        localProvenance,
      );
    } finally {
      cron.stop();
    }
  });

  it("does not authorize an unchanged declarative job, but rebinds a changed declaration", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    const declaration = requesterDeclaration();
    try {
      const created = await cron.add(declaration, { scheduledToolPolicy: requesterPolicy });
      expect(created.toolsAllowProvenance).toBeUndefined();

      expect(
        await cron.add(declaration, {
          scheduledToolPolicy: requesterPolicy,
          toolsAllowProvenance: localProvenance,
        }),
      ).toMatchObject({ created: false, updated: false });
      expect((await loadCronStore(storePath)).jobs[0]?.toolsAllowProvenance).toBeUndefined();

      expect(
        await cron.add(
          {
            ...declaration,
            payload: { kind: "agentTurn", message: "changed report", toolsAllow: ["message"] },
          },
          { scheduledToolPolicy: requesterPolicy, toolsAllowProvenance: localProvenance },
        ),
      ).toMatchObject({ created: false, updated: true });
      expect((await loadCronStore(storePath)).jobs[0]?.toolsAllowProvenance).toEqual(
        localProvenance,
      );
    } finally {
      cron.stop();
    }
  });
});
