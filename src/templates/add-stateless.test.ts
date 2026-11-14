import "../test-utils/prepare-compiled-subprocesses.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  readSessionEntryRow,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareWorkspaceSkillEntries } from "../skills/loading/workspace-skill-loader.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { workspaceIdentity } from "./add-checkpoint.js";
import {
  applyTemplateAddPlanStateless,
  type StatelessTemplateAddOptions,
} from "./add-stateless.js";
import * as bootstrapInstall from "./bootstrap.js";
import * as cronInstall from "./cron.js";
import { buildGatewayTemplateAddPlan } from "./gateway-add-plan.js";
import { projectTemplateAddPlan } from "./gateway-plan-projection.js";
import { bindTemplateSkillWarningConsent } from "./gateway-skill-consent.js";
import * as mcpInstall from "./mcp.js";
import * as packageInstall from "./packages.js";
import { buildTemplateProject, extractBuiltTemplateArtifact } from "./project-build.js";
import { readTemplateManifestFile } from "./reader.js";
import type { TemplateReadResult } from "./types.js";
import * as workspaceFiles from "./workspace.js";

type TemplateConfiguredAgentCheckpoint = Parameters<
  NonNullable<StatelessTemplateAddOptions["onAgentConfigured"]>
>[0];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => clearRuntimeConfigSnapshot());
afterEach(() => vi.unstubAllEnvs());
afterEach(() => vi.restoreAllMocks());
afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("stateless Template Add", () => {
  let stateDir: string;
  let source: Extract<TemplateReadResult, { ok: true }>;
  let config = { agents: { entries: {} } };
  beforeEach(async () => {
    stateDir = tempDirs.make("openclaw-templates-stateless-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sourceRoot = path.join(stateDir, "source");
    mkdirSync(sourceRoot);
    writeFileSync(path.join(sourceRoot, "SOUL.md"), "Workspace agent instructions.\n");
    const manifestPath = path.join(sourceRoot, "CLAW.md");
    writeFileSync(
      manifestPath,
      `---\n${JSON.stringify({
        schemaVersion: 1,
        agent: { id: "workspace-agent", name: "Workspace Agent" },
        workspace: { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } },
      })}\n---\n`,
    );
    const result = await readTemplateManifestFile(manifestPath);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.diagnostics));
    }
    source = result;
    config = { agents: { entries: {} } };
  });
  const buildPlan = () => buildGatewayTemplateAddPlan(source, { config, sourceMcpServers: {} });
  const commitConfig: NonNullable<StatelessTemplateAddOptions["commitConfig"]> = async (
    transform,
  ) => {
    config = transform(config) as typeof config;
  };
  const apply = (
    plan: Awaited<ReturnType<typeof buildPlan>>,
    options: StatelessTemplateAddOptions = {},
  ) =>
    applyTemplateAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig,
      ...options,
    });
  const beginDeletion = (operationId: string) => {
    const agentId = source.manifest.agent.id;
    return beginAgentDeletionJournal({
      operationId,
      deleteFiles: false,
      agentId,
      agentDir: path.join(stateDir, "agents", agentId, "agent"),
      workspaceDir: path.join(stateDir, `workspace-${agentId}`),
      sessionsDir: path.join(stateDir, "agents", agentId, "sessions"),
    });
  };

  it("builds a declared skill folder and discovers its exact supporting bytes after Add", async () => {
    const root = path.join(stateDir, "source");
    const skill = path.join(root, "bundles", "incident-guide");
    await mkdir(path.join(skill, "references"), { recursive: true });
    await writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: incident-guide\ndescription: Use the incident checklist.\n---\nRead references/checklist.txt before drafting.\n",
    );
    const supporting = Buffer.from([0, 255, 17, 128]);
    await writeFile(path.join(skill, "references", "checklist.txt"), supporting);
    await mkdir(path.join(root, "undeclared"));
    await writeFile(
      path.join(root, "undeclared", "SKILL.md"),
      "---\nname: undeclared\ndescription: Never install me.\n---\n",
    );
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "incident-template",
        version: "1.0.0",
        openclaw: { template: "CLAW.md" },
      }),
    );
    await writeFile(
      path.join(root, "CLAW.md"),
      "---\nschemaVersion: 1\nagent: { id: incident-agent }\nskills:\n  - path: bundles/incident-guide\n---\nHelp triage incidents.\n",
    );
    const built = await buildTemplateProject(root, path.join(stateDir, "template.tgz"));
    expect(built.files).toEqual([
      "CLAW.md",
      "bundles/incident-guide/SKILL.md",
      "bundles/incident-guide/references/checklist.txt",
      "package.json",
    ]);
    await using artifact = await extractBuiltTemplateArtifact(built.artifact);
    const read = await readTemplateManifestFile(artifact.packageRoot);
    assert(read.ok, JSON.stringify(read.diagnostics));
    source = read;
    const plan = await buildPlan();
    expect(plan.blockers).toEqual([]);
    const result = await apply(plan);
    expect(result.status, JSON.stringify(result.error)).toBe("complete");
    expect(
      await readFile(
        path.join(plan.agent.workspace, "skills", "incident-guide", "references", "checklist.txt"),
      ),
    ).toEqual(supporting);
    const loaded = await prepareWorkspaceSkillEntries(plan.agent.workspace, {
      config,
      workspaceOnly: true,
      watch: false,
    });
    expect(loaded.entries.map((entry) => entry.skill.name)).toEqual(["incident-guide"]);
    expect(result.packages).toContainEqual(
      expect.objectContaining({
        source: "bundled",
        path: "bundles/incident-guide",
        name: "incident-guide",
      }),
    );
    expect(result.packages[0]).not.toHaveProperty("ref");
    expect(result.packages[0]).not.toHaveProperty("version");
  });

  it("reviews and approves a bundled skill through the native install policy without registry provenance", async () => {
    const root = path.join(stateDir, "source");
    const skill = path.join(root, "bundles", "checked");
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: checked\ndescription: Follow checked instructions.\n---\nRead the checklist.\n",
    );
    await writeFile(
      path.join(root, "CLAW.md"),
      "---\nschemaVersion: 1\nagent: { id: checked-agent }\nskills: [{ path: bundles/checked }]\n---\nUse checked instructions.\n",
    );
    const policy = path.join(stateDir, "policy.cjs");
    const requests = path.join(stateDir, "requests.jsonl");
    await writeFile(
      policy,
      `#!${process.execPath}\nconst fs = require("node:fs"); let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { fs.appendFileSync(${JSON.stringify(requests)}, input + "\\n"); process.stdout.write(JSON.stringify({ protocolVersion: 1, decision: "warn", reason: "Review this packaged skill before installation." })); });\n`,
    );
    await chmod(policy, 0o700);
    const policyConfig: OpenClawConfig = {
      ...config,
      security: {
        installPolicy: {
          enabled: true,
          exec: { source: "exec", command: policy, trustedDirs: [stateDir] },
        },
      },
    };
    const read = await readTemplateManifestFile(root);
    assert(read.ok, JSON.stringify(read.diagnostics));
    source = read;
    const plan = await buildGatewayTemplateAddPlan(source, {
      config: policyConfig,
      sourceMcpServers: {},
    });
    expect(plan.blockers).toEqual([]);
    const projection = projectTemplateAddPlan(plan, root, [], policyConfig);
    expect(projection.blockers).toEqual([]);
    const review = projection.skillReviews[0];
    assert(review && "path" in review);
    expect(review).toMatchObject({ source: "bundled", path: "bundles/checked", name: "checked" });
    expect(review).not.toHaveProperty("ref");
    expect(review).not.toHaveProperty("version");
    expect(() =>
      bindTemplateSkillWarningConsent(projection.skillReviews, undefined, () => {}),
    ).toThrow("acknowledge");
    const acknowledgement = {
      actionId: review.actionId,
      source: "bundled" as const,
      path: review.path,
      digest: review.digest,
      reviewToken: review.reviewToken,
      acknowledgeRiskWarning: true as const,
    };
    expect(() =>
      bindTemplateSkillWarningConsent(
        projection.skillReviews,
        [{ ...acknowledgement, digest: `sha256:${"f".repeat(64)}` }],
        () => {},
      ),
    ).toThrow("changed");
    const skillConsent = bindTemplateSkillWarningConsent(
      projection.skillReviews,
      [acknowledgement],
      () => {},
    );
    const result = await apply(plan, { config: policyConfig, skillConsent });
    expect(result.status, JSON.stringify(result.error)).toBe("complete");
    const loaded = await prepareWorkspaceSkillEntries(plan.agent.workspace, {
      config: policyConfig,
      workspaceOnly: true,
      watch: false,
    });
    expect(loaded.entries.map((entry) => entry.skill.name)).toEqual(["checked"]);
    const nativeRequests = (await readFile(requests, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(nativeRequests.length).toBeGreaterThanOrEqual(3);
    for (const request of nativeRequests) {
      expect(request).toMatchObject({
        targetType: "skill",
        source: { kind: "local-path", authority: "third-party", mutable: false, network: false },
        origin: { type: "path", spec: "bundles/checked" },
      });
    }
  });

  it.each(["bytes", "membership"])(
    "refuses a bundled skill whose %s changed after Add review",
    async (change) => {
      const root = path.join(stateDir, "source");
      const skill = path.join(root, "bundles", "checked");
      await mkdir(skill, { recursive: true });
      await writeFile(
        path.join(skill, "SKILL.md"),
        "---\nname: checked\ndescription: Follow the checked instructions.\n---\nRead the checklist.\n",
      );
      await writeFile(
        path.join(root, "CLAW.md"),
        "---\nschemaVersion: 1\nagent: { id: checked-agent }\nskills: [{ path: bundles/checked }]\n---\nUse checked instructions.\n",
      );
      const read = await readTemplateManifestFile(root);
      assert(read.ok, JSON.stringify(read.diagnostics));
      source = read;
      const plan = await buildPlan();
      expect(plan.blockers).toEqual([]);
      await writeFile(
        path.join(skill, change === "membership" ? "added.txt" : "SKILL.md"),
        "changed after review",
      );
      const result = await apply(plan);
      expect(result.status).toBe("partial");
      expect(config.agents.entries).not.toHaveProperty("checked-agent");
      expect(existsSync(path.join(plan.agent.workspace, "skills", "checked"))).toBe(false);
    },
  );

  it("reuses a deleted agent ID without leaving its database fenced", async () => {
    const agentId = source.manifest.agent.id;
    const deletion = beginDeletion("prior-deletion");
    runOpenClawStateWriteTransaction((database) =>
      completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
    );
    expect(isAgentDeletionBlocked(agentId)).toBe(true);
    expect(() =>
      runOpenClawAgentWriteTransaction(() => undefined, { agentId, env: process.env }),
    ).toThrow(`agent ${agentId} is deleted`);

    const plan = await buildPlan();
    const prepareAgentSession = vi.fn(async () => {
      expect(isAgentDeletionBlocked(agentId)).toBe(false);
      runOpenClawAgentWriteTransaction(
        (database) =>
          writeSessionEntry(database, `agent:${agentId}:main`, {
            sessionId: "prepared-chat-after-readd",
            updatedAt: Date.now(),
          }),
        { agentId, env: process.env },
      );
      return async () => {};
    });
    const result = await apply(plan, { prepareAgentSession, getCurrentConfig: () => config });

    expect(prepareAgentSession).toHaveBeenCalledOnce();
    expect(result.status).toBe("complete");
    expect(readAgentDeletionJournal(agentId, {}, "runtime")).toBeUndefined();
    expect(isAgentDeletionBlocked(agentId)).toBe(false);
    expect(config.agents.entries).toHaveProperty(agentId);
    expect(() =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          writeSessionEntry(database, `agent:${agentId}:main`, {
            sessionId: "new-chat-after-readd",
            updatedAt: Date.now(),
          }),
        { agentId, env: process.env },
      ),
    ).not.toThrow();
  });

  it("does not publish an agent while its prior deletion is unfinished", async () => {
    const agentId = source.manifest.agent.id;
    beginDeletion("pending-deletion");

    const plan = await buildPlan();
    const result = await apply(plan);

    expect(result).toMatchObject({
      status: "partial",
      error: { code: "agent_deletion_pending" },
      configCommitted: false,
    });
    expect(config.agents.entries).not.toHaveProperty(agentId);
    expect(readAgentDeletionJournal(agentId, {}, "runtime")?.cleanupCompleted).toBe(false);
  });

  it("makes the instructed agent and its canonical chat ready before deferrable setup", async () => {
    const plan = await buildPlan();
    plan.actions.push({
      kind: "package",
      action: "install",
      blocked: false,
      id: "notes",
      target: "notes",
      details: { kind: "plugin" },
    });
    const order: string[] = [];
    vi.spyOn(bootstrapInstall, "seedTemplatePackageBootstrap").mockImplementation(async () => {
      order.push("bootstrap");
      return undefined;
    });
    const greetingStarted = createDeferred();
    const greetingFinished = createDeferred();
    const routines = vi
      .spyOn(cronInstall, "installTemplateCronJobsStateless")
      .mockResolvedValue([]);
    const packages = vi
      .spyOn(packageInstall, "installTemplatePackages")
      .mockImplementation(async () => {
        order.push("packages");
        expect(order).toContain("agent-ready");
        return [];
      });
    const mcp = vi
      .spyOn(mcpInstall, "installTemplateMcpServersStateless")
      .mockImplementation(async () => {
        order.push("mcp");
      });
    const installation = apply(plan, {
      getCurrentConfig: () => config,
      prepareAgentSession: async () => {
        expect(readFileSync(path.join(plan.agent.workspace, "SOUL.md"), "utf8")).toBe(
          "Workspace agent instructions.\n",
        );
        order.push("session");
        return async () => {
          throw new Error("exposed chat must not be deleted");
        };
      },
      waitForAgentRuntime: async () => {
        expect(config.agents.entries).toHaveProperty(plan.agent.finalId);
        order.push("runtime");
        return "applied";
      },
      onAgentReady: async (agent) => {
        expect(agent).toEqual({
          agentId: "workspace-agent",
          sessionKey: "agent:workspace-agent:main",
        });
        order.push("agent-ready");
        greetingStarted.resolve();
        await greetingFinished.promise;
        order.push("greeting-visible");
      },
    });
    try {
      await awaitGateBeforeSettlement(
        greetingStarted.promise,
        installation,
        "Template Add finished before the normal greeting started",
      );
      expect(packages).not.toHaveBeenCalled();
      expect(mcp).not.toHaveBeenCalled();
      expect(routines).not.toHaveBeenCalled();
    } finally {
      greetingFinished.resolve();
    }
    const result = await installation;
    expect(result.status).toBe("complete");
    expect(order).toEqual([
      "session",
      "runtime",
      "agent-ready",
      "greeting-visible",
      "packages",
      "mcp",
      "bootstrap",
    ]);
    expect(routines).toHaveBeenCalledOnce();
  });

  it("retains an adopted agent and its chat when later setup fails", async () => {
    const plan = await buildPlan();
    const rollbackChat = vi.fn(async () => {});
    const result = await apply(plan, {
      getCurrentConfig: () => config,
      prepareAgentSession: async () => rollbackChat,
      waitForAgentRuntime: async () => {
        runOpenClawAgentWriteTransaction(
          (database) =>
            writeSessionEntry(database, "agent:workspace-agent:main", {
              sessionId: "chat-after-runtime-publication",
              updatedAt: Date.now(),
            }),
          { agentId: plan.agent.finalId, env: process.env },
        );
        return "applied";
      },
      onAgentReady: async () => {
        throw new Error("setup policy changed");
      },
    });
    expect(rollbackChat).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "partial",
      configCommitted: true,
      workspaceCreated: true,
      agentRetained: true,
      error: { code: "add_failed", message: expect.stringContaining("setup policy changed") },
    });
    expect(config.agents.entries).toHaveProperty(plan.agent.finalId);
    expect(existsSync(plan.agent.workspace)).toBe(true);
    expect(
      runOpenClawAgentWriteTransaction(
        (database) => readSessionEntryRow(database, "agent:workspace-agent:main")?.entry.sessionId,
        { agentId: plan.agent.finalId, env: process.env },
      ),
    ).toBe("chat-after-runtime-publication");
  });

  it.each([
    "unchanged",
    "source-root",
    "workspace",
    "config",
    "source",
    "consent",
    "plan",
    "phase-only",
  ] as const)(
    "retries configured initialization without rewriting its agent or chat (%s)",
    async (change) => {
      if (change === "source-root") {
        const root = path.join(stateDir, "source");
        await writeFile(
          path.join(root, "package.json"),
          JSON.stringify({
            name: "@test/workspace-agent-template",
            version: "1.0.0",
            openclaw: { template: "CLAW.md" },
          }),
        );
        const loaded = await readTemplateManifestFile(root);
        assert(loaded.ok);
        source = {
          ...loaded,
          source: {
            ...loaded.source,
            integrityKind: "artifact",
            integrity: `sha256:${"a".repeat(64)}`,
          },
        };
      }
      const plan = await buildPlan();
      let checkpoint: TemplateConfiguredAgentCheckpoint | undefined;
      const onAgentReady = vi.fn(async () => {});
      const prepareAgentSession = vi.fn(async () => {
        runOpenClawAgentWriteTransaction(
          (database) =>
            writeSessionEntry(database, "agent:workspace-agent:main", {
              sessionId: "pending-configured-chat",
              updatedAt: Date.now(),
            }),
          { agentId: plan.agent.finalId, env: process.env },
        );
        return async () => {
          throw new Error("Retained chat must not be deleted");
        };
      });
      let policyConfig = config;
      const failed = await apply(plan, {
        getCurrentConfig: () => policyConfig,
        prepareEffect: async () => {
          policyConfig = config;
        },
        prepareAgentSession,
        onAgentConfigured: async (value) => {
          checkpoint = value;
          expect(value.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
          expect(value.sourceIntegrity).toMatch(/^sha256:[a-f0-9]{64}$/);
        },
        waitForAgentRuntime: async () => {
          throw new Error("runtime unavailable");
        },
        onAgentReady,
      });
      expect(failed).toMatchObject({
        status: "partial",
        agentRetained: true,
        configCommitted: true,
        error: { message: expect.stringContaining("runtime unavailable") },
      });
      assert(checkpoint);
      expect(onAgentReady).not.toHaveBeenCalled();
      if (change === "workspace") {
        await writeFile(path.join(plan.agent.workspace, "SOUL.md"), "User-edited instructions.");
      } else if (change === "config") {
        config = {
          ...config,
          agents: {
            entries: { ...config.agents.entries, [plan.agent.finalId]: { name: "Changed" } },
          },
        };
      } else if (change === "source") {
        await writeFile(path.join(stateDir, "source", "SOUL.md"), "Changed after consent.");
      } else if (change === "plan") {
        plan.actions[0]!.reason = "Changed plan despite unchanged claimed integrity";
      } else if (change === "source-root") {
        const oldRoot = plan.template.packageRoot;
        const newRoot = path.join(stateDir, "retry-source");
        await cp(oldRoot, newRoot, { recursive: true });
        plan.template.packageRoot = newRoot;
        plan.template.manifestPath = path.join(newRoot, "CLAW.md");
        for (const action of plan.actions) {
          if (action.source) {
            action.source = path.join(newRoot, path.relative(oldRoot, action.source));
          }
        }
        plan.planIntegrity = "newly-reviewed-integrity-at-new-source-root";
      }
      const writeWorkspace = vi.spyOn(workspaceFiles, "createTemplateWorkspaceFiles");
      const commit = vi.fn(commitConfig);
      const runtimeStarted = createDeferred();
      const runtimeReady = createDeferred();
      const waitForAgentRuntime = vi.fn(async () => {
        runtimeStarted.resolve();
        await runtimeReady.promise;
        return "applied" as const;
      });
      const retry = apply(plan, {
        consentPlanIntegrity: change === "consent" ? "changed" : plan.planIntegrity,
        getCurrentConfig: () => config,
        commitConfig: commit,
        prepareAgentSession,
        admittedAgent: {
          ...checkpoint,
          ...(change === "phase-only" ? { planDigest: undefined, sourceIntegrity: undefined } : {}),
          phase: "configured",
          assertCurrent: async () => {},
        },
        waitForAgentRuntime,
        onAgentReady,
      }).catch((error: unknown) => ({ error }));
      const succeeds = change === "unchanged" || change === "source-root";
      if (succeeds) {
        try {
          await awaitGateBeforeSettlement(
            runtimeStarted.promise,
            retry,
            "Configured retry settled before runtime readiness",
          );
          expect(onAgentReady).not.toHaveBeenCalled();
          expect(await workspaceIdentity(plan.agent.workspace)).toBe(checkpoint.workspaceIdentity);
        } finally {
          runtimeReady.resolve();
        }
      }
      const retried = await retry;
      expect(writeWorkspace).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(prepareAgentSession).toHaveBeenCalledOnce();
      if (succeeds) {
        expect(retried).toMatchObject({ status: "complete", agentRetained: true });
        expect(waitForAgentRuntime).toHaveBeenCalledOnce();
        expect(onAgentReady).toHaveBeenCalledOnce();
      } else {
        expect(retried.error).toBeDefined();
        expect(waitForAgentRuntime).not.toHaveBeenCalled();
        expect(onAgentReady).not.toHaveBeenCalled();
      }
      expect(
        runOpenClawAgentWriteTransaction(
          (database) =>
            readSessionEntryRow(database, "agent:workspace-agent:main")?.entry.sessionId,
          { agentId: plan.agent.finalId, env: process.env },
        ),
      ).toBe("pending-configured-chat");
    },
  );

  it("keeps a failed configured checkpoint pending without starting runtime or greeting", async () => {
    const plan = await buildPlan();
    const waitForAgentRuntime = vi.fn(async () => "applied" as const);
    const onAgentReady = vi.fn(async () => {});
    const rollbackChat = vi.fn(async () => {});
    let checkpoint: TemplateConfiguredAgentCheckpoint | undefined;
    const result = await apply(plan, {
      prepareAgentSession: async () => rollbackChat,
      getCurrentConfig: () => config,
      onAgentConfigured: async (value) => {
        checkpoint = value;
        throw new Error("checkpoint acknowledgement lost");
      },
      waitForAgentRuntime,
      onAgentReady,
    });
    expect(result).toMatchObject({
      status: "partial",
      agentRetained: true,
      configCommitted: true,
      error: { message: expect.stringContaining("checkpoint acknowledgement lost") },
    });
    expect(rollbackChat).not.toHaveBeenCalled();
    expect(config.agents.entries).toHaveProperty(plan.agent.finalId);
    expect(await readFile(path.join(plan.agent.workspace, "SOUL.md"), "utf8")).toBe(
      "Workspace agent instructions.\n",
    );
    expect(waitForAgentRuntime).not.toHaveBeenCalled();
    expect(onAgentReady).not.toHaveBeenCalled();
    assert(checkpoint);
    const retry = await apply(plan, {
      getCurrentConfig: () => config,
      admittedAgent: {
        config: checkpoint.config,
        workspaceIdentity: await workspaceIdentity(plan.agent.workspace),
        phase: "admitted",
        assertCurrent: async () => {},
      },
      waitForAgentRuntime,
      onAgentReady,
    });
    expect(retry).toMatchObject({ status: "partial", agentRetained: true });
    expect(waitForAgentRuntime).not.toHaveBeenCalled();
    expect(onAgentReady).not.toHaveBeenCalled();
  });

  it("adds numbered ordinary agents without an install record", async () => {
    const onSetupEvent = vi.fn();
    const add = async () => apply(await buildPlan(), { onSetupEvent });

    const first = await add();
    const second = await add();

    expect(first.status).toBe("complete");
    expect(onSetupEvent).not.toHaveBeenCalled();
    expect(first).not.toHaveProperty("installRecord");
    expect(second).toMatchObject({
      status: "complete",
      agent: { finalId: "workspace-agent-2", config: { name: "Workspace Agent 2" } },
    });
    expect(Object.keys(config.agents.entries)).toEqual([
      "main",
      "workspace-agent",
      "workspace-agent-2",
    ]);
    expect(existsSync(path.join(stateDir, "workspace-workspace-agent-2", "SOUL.md"))).toBe(true);
  });

  it.each(["workspace failure", "lost config acknowledgement"] as const)(
    "rolls back the new agent and reseeds bootstrap on retry after %s",
    async (failure) => {
      const bootstrap = "Run these first-time agent instructions.\n";
      writeFileSync(path.join(stateDir, "source", "BOOTSTRAP.md"), bootstrap);
      const reread = await readTemplateManifestFile(path.join(stateDir, "source", "CLAW.md"));
      assert(reread.ok);
      source = reread;
      const plan = await buildPlan();
      let writes = 0;
      const message =
        failure === "workspace failure" ? "test file failure" : "write acknowledgment lost";
      if (failure === "workspace failure") {
        vi.spyOn(workspaceFiles, "createTemplateWorkspaceFiles").mockRejectedValueOnce(
          new Error(message),
        );
      }
      const result = await apply(
        plan,
        failure === "workspace failure"
          ? {}
          : {
              getCurrentConfig: () => config,
              commitConfig: async (transform) => {
                config = transform(config) as typeof config;
                if (++writes === 1) {
                  throw new Error(message);
                }
              },
            },
      );
      expect(result).toMatchObject({
        status: "partial",
        configCommitted: false,
        workspaceCreated: false,
        error: { code: "add_failed", message },
      });
      expect(Object.keys(config.agents.entries)).toEqual(
        failure === "workspace failure" ? [] : ["main"],
      );
      expect(existsSync(plan.agent.workspace)).toBe(false);

      const retryPlan = await buildPlan();
      expect(retryPlan.agent.workspace).toBe(plan.agent.workspace);
      const retried = await apply(retryPlan);
      expect(retried.status).toBe("complete");
      expect(await readFile(path.join(retryPlan.agent.workspace, "BOOTSTRAP.md"), "utf8")).toBe(
        bootstrap,
      );
    },
  );

  it("keeps an exposed workspace if its files changed before rollback", async () => {
    const plan = await buildPlan();
    vi.spyOn(cronInstall, "installTemplateCronJobsStateless").mockImplementationOnce(async () => {
      writeFileSync(path.join(plan.agent.workspace, "USER.md"), "new user content");
      throw new Error("scheduler unavailable");
    });
    const result = await apply(plan);

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: true,
      workspaceCreated: true,
      error: { code: "add_rollback_incomplete" },
    });
    expect(result.error?.message).toContain("Workspace changed");
    expect(Object.keys(config.agents.entries)).toEqual(["main", "workspace-agent"]);
    expect(existsSync(path.join(plan.agent.workspace, "USER.md"))).toBe(true);
  });

  it("does not touch shared requirements when agent publication fails", async () => {
    const plan = await buildPlan();
    plan.actions.push({
      kind: "package",
      id: "notes",
      action: "install",
      target: "notes",
      details: { kind: "plugin" },
      blocked: false,
    });
    const packages = vi.spyOn(packageInstall, "installTemplatePackages");
    const mcp = vi.spyOn(mcpInstall, "installTemplateMcpServersStateless");
    const result = await apply(plan, {
      commitConfig: async () => {
        throw new Error("publish failed");
      },
      getCurrentConfig: () => ({ agents: { entries: {} } }),
    });
    expect(result).toMatchObject({
      status: "partial",
      error: { code: "add_failed", message: "publish failed" },
      packages: [],
      mcpServers: [],
    });
    expect(packages).not.toHaveBeenCalled();
    expect(mcp).not.toHaveBeenCalled();
    expect(existsSync(plan.agent.workspace)).toBe(false);
  });
});
