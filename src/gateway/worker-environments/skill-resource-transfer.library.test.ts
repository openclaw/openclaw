import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { prepareEmbeddedSessionState } from "../../agents/command/session-preparation.js";
import { createAdmittedHostCapabilityTestFixture } from "../../agents/harness/host-capability.test-support.js";
import { createOriginalIssuerFixture } from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import {
  withSessionSkillResources,
  resolveSessionSkillResourceSnapshot,
} from "../../agents/session-placement-skill-resources.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { seedSkillLibrarySelection } from "../../skills/library/selection.js";
import { saveSkillLibrary } from "../../skills/library/service.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { placementTurnOwner } from "./placement-record.js";
import { createRemoteExecPlacementSandbox } from "./placement-sandbox.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import { createNodeCarrier } from "./skill-resource-transfer.test-support.js";
import { attachedEnvironment } from "./worker-turn-launcher.test-support.js";

afterEach(() => vi.unstubAllEnvs());

it("delivers the selected library alias through the placement sandbox into the harness catalog", async () => {
  await withOpenClawTestState({ label: "selected-resource-catalog" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const issuer = await createOriginalIssuerFixture(state, 0, "current grant");
    const authority = expectDefined(issuer.original, "original human authority").authority;
    const runId = "selected-resource-catalog";
    let resources: Awaited<ReturnType<typeof transferSkillResources>>;
    let host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>> | undefined;
    let readDelivered: (() => Promise<unknown>) | undefined;
    try {
      const libraryAuthority = {
        profileId: authority.profileId,
        scopes: authority.scopes,
        assertCurrent: authority.assertCurrent,
        getConfig: () => issuer.cfg,
      };
      const content =
        "---\nname: implement-it\ndescription: Pinned implementation instructions\n---\n# Implement\nPreserve the selected revision.\n";
      await saveSkillLibrary(libraryAuthority, {
        slug: "implement",
        content,
        expectedRevision: null,
        files: [],
      });
      const seeded = expectDefined(
        (await seedSkillLibrarySelection(libraryAuthority))[0],
        "selected library pin",
      );
      const pins = [{ ...seeded, name: "s_implement_347933c0de22421bbd92" }];
      issuer.cfg.agents!.entries!.main = {
        ...issuer.cfg.agents?.entries?.main,
        skills: [pins[0]!.name],
      };
      const sessionId = "selected-resource-session";
      const sessionKey = "agent:main:selected-resource";
      const prepared = await prepareEmbeddedSessionState({
        cfg: issuer.cfg,
        opts: { message: "Read selected instructions" },
        sessionEntry: { sessionId, updatedAt: 1, skillLibrarySelections: pins },
        sessionId,
        sessionKey,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionAgentId: "main",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        runId,
        executionWorkspaceDir: state.workspaceDir,
        watchSkills: false,
        isNewSession: false,
        isSubagentLaneTurn: false,
        suppressVisibleSessionEffects: false,
        sessionStateActor: { actorType: "human", actorId: issuer.profile.id },
      });
      const snapshot = expectDefined(prepared.skillsSnapshot, "hydrated selected snapshot");
      expect(snapshot.resolvedSkills?.some((skill) => skill.name === pins[0]!.name)).toBe(true);
      await fs.mkdir(state.path("node"));
      const carrier = await createNodeCarrier(state.path("node"));
      const database = openOpenClawStateDatabase();
      const placements = createWorkerSessionPlacementStore({ database });
      const placement = await advancePlacementFixtureToActive(
        placements,
        database,
        { agentId: "main", sessionId, sessionKey, executionMode: "remote-exec" },
        { remoteWorkspaceDir: carrier.workspace },
      );
      const claim = await placements.claimTurn({
        agentId: "main",
        sessionId,
        sessionKey,
        claimId: "selected-resource-claim",
        runId,
        owner: placementTurnOwner(placement),
      });
      const assertCurrent = () => {
        authority.assertCurrent();
        if (!placements.validateTurnClaim(claim)) {
          throw new Error("Selected resource claim retired");
        }
      };
      const environment = {
        ...attachedEnvironment(),
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
        attachedSessionIds: [sessionId],
        nodeDeviceId: "selected-node",
        sshEndpoint: null,
      };
      resources = expectDefined(
        await transferSkillResources({
          snapshot,
          tunnel: carrier,
          workspaceDir: state.workspaceDir,
          remoteWorkspaceDir: carrier.workspace,
          assertCurrent,
        }),
        "delivered resources",
      );
      expect(resources.mounts).toHaveLength(1);
      const remoteFile = path.posix.join(resources.mounts[0]!.containerPath, "SKILL.md");
      expect(await fs.readFile(remoteFile, "utf8")).toBe(content);
      await withSessionSkillResources(resources, async () => {
        expect(() => resolveSessionSkillResourceSnapshot(structuredClone(snapshot))).toThrow(
          "Skill resources belong to a different prepared turn",
        );
        const sandbox = await createRemoteExecPlacementSandbox({
          placement,
          workspaceDir: state.workspaceDir,
          config: issuer.cfg,
          environments: { get: () => environment },
        });
        expect(sandbox.fsBridge).toBeUndefined();
        host = await createAdmittedHostCapabilityTestFixture(
          {
            runId,
            agentId: "main",
            sessionId,
            sessionKey,
            workspaceDir: state.workspaceDir,
            config: issuer.cfg,
            sandbox,
            skillsSnapshot: resolveSessionSkillResourceSnapshot(snapshot),
          },
          { operatorAuthority: authority },
        );
        const tools = expectDefined(
          host.hostCapabilities.createToolSurface,
          "actual harness tool preparation",
        )({
          config: issuer.cfg,
          workspaceDir: state.workspaceDir,
          sandbox,
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeShellTools: false,
            includeChannelTools: true,
            includeOpenClawTools: true,
            includePluginTools: true,
          },
        });
        const read = expectDefined(
          tools.find((tool) => tool.name === "skills_read"),
          "actual installed skill reader",
        );
        expect((await read.execute("read-delivered", { name: pins[0]!.name })).content).toEqual([
          { type: "text", text: content },
        ]);
        readDelivered = () => read.execute("read-retired", { name: pins[0]!.name });
        await expect(
          read.execute("read-cancelled", { name: pins[0]!.name }, AbortSignal.abort()),
        ).rejects.toThrow();
        await expect(
          resources!.skillResources.readInstructions(seeded.skillId + "/SKILL.md", {}),
        ).rejects.toThrow("not available in this delivered turn");
        expect(resources!.snapshot.prompt).toContain(remoteFile);
        expect(resources!.snapshot.prompt).toContain(`<name>${pins[0]!.name}</name>`);
        expect(resources!.snapshot.prompt).not.toContain(seeded.skillId + "/");
        expect(resources!.snapshot.librarySelections).toEqual(pins);
      });
      const admittedHost = expectDefined(host, "prepared harness host");
      const createToolSurface = expectDefined(
        admittedHost.hostCapabilities.createToolSurface,
        "actual harness tool preparation",
      );
      await resources.cleanup();
      resources = undefined;
      await expect(expectDefined(readDelivered, "retained installed skill read")()).rejects.toThrow(
        "not available in this delivered turn",
      );
      await expect(fs.stat(remoteFile)).rejects.toMatchObject({ code: "ENOENT" });
      admittedHost.closeHost();
      expect(() =>
        createToolSurface({ config: issuer.cfg, workspaceDir: state.workspaceDir }),
      ).toThrow();
      admittedHost.closeAdmission();
      admittedHost.closeGateway();
      host = undefined;
    } finally {
      host?.closeHost();
      host?.closeAdmission();
      host?.closeGateway();
      await resources?.cleanup();
      issuer.original!.release();
      issuer.deviceSource.release();
      issuer.runtime.close();
      await issuer.work.drain();
      clearAgentRunContext(runId);
      await closeSkillsWatchers(true);
    }
  });
});
