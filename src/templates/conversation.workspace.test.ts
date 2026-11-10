import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import * as runtimeConfig from "../agents/agent-runtime-config.js";
import { prepareAgentCommandExecution } from "../agents/command/prepare.js";
import { readCanonicalWorkspaceStateSnapshot } from "../agents/workspace-state-read.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { loadWorkspaceBootstrapFiles } from "../agents/workspace.js";
import { prepareReplyWorkspace } from "../auto-reply/reply/reply-workspace.js";
import { createThrowingTestRuntime } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applyTemplateAddPlanStateless,
  type StatelessTemplateAddOptions,
} from "./add-stateless.js";
import { seedTemplatePackageBootstrap } from "./bootstrap.js";
import { buildGatewayTemplateAddPlan } from "./gateway-add-plan.js";
import * as packageInstall from "./packages.js";
import { readTemplateManifestFile } from "./reader.js";

// No model call: exercise both ordinary workspace preparation owners, the shared
// installer and the real seed-once owner. Adapter dispatch has separate coverage.
it.each([
  { transport: "cli", failSeed: false },
  { transport: "gateway", failSeed: false },
  { transport: "gateway", failSeed: true },
] as const)(
  "keeps custom SOUL and deferred package bootstrap through $transport preparation (seed failure=$failSeed)",
  async ({ transport, failSeed }) => {
    await withOpenClawTestState({ label: "template-conversation-bootstrap" }, async (state) => {
      const root = state.path("template");
      await fs.mkdir(root);
      const soul = "A calm fixture personality.\n";
      const bootstrap = "Connect the declared calendar, then ask about priorities.";
      await fs.writeFile(path.join(root, "SOUL.md"), soul);
      await fs.writeFile(path.join(root, "BOOTSTRAP.md"), bootstrap);
      const manifest = path.join(root, "CLAW.md");
      await fs.writeFile(
        manifest,
        "---\n" +
          JSON.stringify({
            schemaVersion: 1,
            agent: { id: "scout", name: "Scout" },
            workspace: { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } },
          }) +
          "\n---\n",
      );
      const source = await readTemplateManifestFile(manifest);
      if (!source.ok) {
        throw new Error("Invalid fixture Template");
      }
      let config: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.path("main") } },
          defaults: { model: "ollama/test-model" },
        },
        plugins: { enabled: false },
      };
      await state.writeConfig(config);
      const plan = await buildGatewayTemplateAddPlan(source, { config, sourceMcpServers: {} });
      expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "bootstrap" }));
      using _ = vi
        .spyOn(runtimeConfig, "resolveAgentRuntimeConfig")
        .mockImplementation(async () => config);
      const prepareWorkspace = async (deferWorkspaceBootstrap = true) => {
        const deferred = deferWorkspaceBootstrap ? { deferWorkspaceBootstrap: true as const } : {};
        if (transport === "cli") {
          const prepared = await prepareAgentCommandExecution(
            {
              ...deferred,
              agentId: "scout",
              sessionKey: "agent:scout:main",
              message: "Explain setup without performing it.",
              toolsAllow: [],
            },
            createThrowingTestRuntime(),
          );
          await prepared.runLease?.release();
        } else {
          await prepareReplyWorkspace({
            ...deferred,
            dir: plan.agent.workspace,
            ensureBootstrapFiles: true,
            useFastTestBootstrap: false,
            provisioningInput: {
              cfg: config,
              agentId: "scout",
              workspaceDir: plan.agent.workspace,
            },
          });
        }
      };
      const prepare = async (deferred = true) => {
        await prepareWorkspace(deferred);
        const files = await loadWorkspaceBootstrapFiles(plan.agent.workspace);
        expect(files.find((file) => file.name === "SOUL.md")?.content).toBe(soul);
        await expect(
          fs.readFile(path.join(plan.agent.workspace, "BOOTSTRAP.md"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          (await readCanonicalWorkspaceStateSnapshot(plan.agent.workspace)).setup,
        ).not.toHaveProperty("setupCompletedAt");
      };
      plan.actions.push({
        kind: "package",
        action: "install",
        blocked: false,
        id: "calendar",
        target: "calendar",
        details: { kind: "plugin" },
      });
      const installStarted = createDeferred();
      const installFinished = createDeferred();
      using install = vi
        .spyOn(packageInstall, "installTemplatePackages")
        .mockImplementation(async () => {
          installStarted.resolve();
          await installFinished.promise;
          return [];
        });
      const apply = (leaseSet?: StatelessTemplateAddOptions["leaseSet"]) =>
        applyTemplateAddPlanStateless(plan, {
          ...(leaseSet ? { stateMode: "worker" as const, leaseSet } : {}),
          consentPlanIntegrity: plan.planIntegrity,
          getCurrentConfig: () => config,
          commitConfig: async (transform) => {
            config = transform(config);
          },
          prepareAgentSession: async () => async () => {},
          waitForAgentRuntime: async () => {
            // Offline runtime admission also prepares the ordinary command workspace.
            if (transport === "cli") {
              await prepare();
            }
            return "applied";
          },
          onAgentReady: () => prepare(),
        });
      const { withExistingOpenClawStateSchema } =
        await import("../state/openclaw-state-db-schema-policy.js");
      const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
      const { withOpenClawStateLeaseAsync } = await import("../state/openclaw-state-lease.js");
      const { captureOpenClawStateWorkerContext } =
        await import("../state/openclaw-state-worker-context.js");
      const leaseOptions = {
        key: "scout",
        leaseMs: 60_000,
        waitMs: 0,
        heartbeat: "worker" as const,
      };
      const exerciseEarlyTurn = async (leaseSet?: StatelessTemplateAddOptions["leaseSet"]) => {
        const installation = apply(leaseSet);
        try {
          await awaitGateBeforeSettlement(
            installStarted.promise,
            installation,
            "Template Add settled before dependency installation",
          );
          // Ordinary user turns do not carry the installer's explicit deferral flag.
          await prepare(false);
          if (failSeed) {
            await fs.writeFile(path.join(root, "BOOTSTRAP.md"), "Changed after consent.");
          }
        } finally {
          installFinished.resolve();
          // Join installer cleanup even when the early-turn regression fails.
          await installation;
        }
        const result = await installation;
        if (failSeed) {
          expect(result).toMatchObject({
            status: "partial",
            agentRetained: true,
            configCommitted: true,
            error: {
              code: "add_failed",
              message: expect.stringContaining("changed after consent"),
            },
          });
          // Retained failure must not hand bootstrap custody back to an ordinary turn.
          await prepare(false);
          const seedOptions = leaseSet ? { stateMode: "worker" as const, leaseSet } : {};
          await expect(seedTemplatePackageBootstrap(plan, seedOptions)).rejects.toThrow(
            "changed after consent",
          );
          await prepare(false);
          await fs.writeFile(path.join(root, "BOOTSTRAP.md"), bootstrap);
          await expect(seedTemplatePackageBootstrap(plan, seedOptions)).resolves.toBe("seeded");
        }
        return result;
      };
      const result =
        transport === "cli"
          ? await exerciseEarlyTurn()
          : await withExistingOpenClawStateSchema(
              { path: openOpenClawStateDatabase().path },
              async () => {
                const context = captureOpenClawStateWorkerContext();
                return withOpenClawStateLeaseAsync(
                  { ...leaseOptions, scope: "core:template-add-allocation" },
                  context,
                  (allocation) =>
                    withOpenClawStateLeaseAsync(
                      { ...leaseOptions, scope: "core:agent-deletion" },
                      context,
                      (agent) => exerciseEarlyTurn({ context, leases: [allocation, agent] }),
                    ),
                );
              },
            );
      expect(install).toHaveBeenCalledOnce();
      if (!failSeed) {
        expect(result.error).toBeUndefined();
        expect(result).toMatchObject({ status: "complete" });
      }
      expect(await fs.readFile(path.join(plan.agent.workspace, "BOOTSTRAP.md"), "utf8")).toBe(
        bootstrap,
      );
      // Durability is distinct from the primed host snapshot; do not clear that cache.
      expect(
        (await readWorkspaceStateSnapshot(plan.agent.workspace, { readOnly: true })).setup,
      ).toMatchObject({ bootstrapSeededAt: expect.any(String) });
      const { resolveBootstrapContextForRun } = await import("../agents/bootstrap-files.js");
      const loadContext = () =>
        resolveBootstrapContextForRun({
          workspaceDir: plan.agent.workspace,
          sessionKey: "agent:scout:main",
        });
      const bootstrapPath = path.join(plan.agent.workspace, "BOOTSTRAP.md");
      for (let turn = 0; turn < 2; turn++) {
        await prepareWorkspace(false);
        expect(
          (await readCanonicalWorkspaceStateSnapshot(plan.agent.workspace)).setup,
        ).not.toHaveProperty("setupCompletedAt");
        expect(
          (await loadContext()).contextFiles.find((file) => file.path === bootstrapPath)?.content,
        ).toBe(bootstrap);
      }
      await fs.rm(bootstrapPath);
      await prepareWorkspace(false);
      expect(
        (await readCanonicalWorkspaceStateSnapshot(plan.agent.workspace)).setup,
      ).toHaveProperty("setupCompletedAt");
      await expect(seedTemplatePackageBootstrap(plan)).resolves.toBe("consumed");
      await expect(fs.readFile(bootstrapPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await loadContext()).contextFiles.some((file) => file.path === bootstrapPath)).toBe(
        false,
      );
    });
  },
);
