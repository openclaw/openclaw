import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../../../test/helpers/private-update-handoff-store.js";
import { handlePluginCommand } from "../../../auto-reply/reply/commands-plugin.js";
import { buildCommandTestParams } from "../../../auto-reply/reply/commands.test-harness.js";
import { runWithCommandNativeSubagents } from "../../../auto-reply/reply/dispatch-native-subagent.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import {
  clearConfigCache,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "../../../plugins/loader.js";
import type { PluginRegistry } from "../../../plugins/registry-types.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  disposePluginRegistryInstances,
} from "../../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import {
  readAdmittedRunOperatorAuthority,
  resolvePreparedRunAdmission,
} from "../../admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../../agent-scope.js";
import { createOpenClawCodingToolsInternalAsync } from "../../agent-tools.js";
import { ToolSearchRuntime } from "../../tool-search-runtime.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "../../tool-search.js";
import { visibleResult } from "./subagent-spawn.fixtures.test-support.js";
import {
  createSpawnOperatorSource,
  createSpawnTranscriptTarget,
  recordSpawnBoundaryFinal,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

const pluginId = "profile-gateway-proof";
const instructions = "PROFILE_REVIEWER_PINNED: inspect the change without modifying any files.\n";
const schema = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["approved"] } },
  required: ["verdict"],
  additionalProperties: false,
};

async function writeDiskPlugin(workspace: string) {
  const root = path.join(workspace, "review-plugin");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "reviewer.md"), instructions);
  await fs.writeFile(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object", properties: {}, additionalProperties: false },
      contracts: { commandRuntimeCapabilities: ["subagents"], subagentProfiles: ["reviewer"] },
    }),
  );
  const entry = path.join(root, "index.cjs");
  // This fixture deliberately has no core imports or injected registry/runtime objects.
  await fs.writeFile(
    entry,
    `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
      if (!api.runtime.capabilities.includes("native-subagent-profiles-v1") ||
          typeof api.agent.registerSubagentProfile !== "function") {
        throw new Error("Native subagent profiles are unsupported");
      }
      api.agent.registerSubagentProfile({
        id: "reviewer", description: "Read-only reviewer", instructionsFile: "reviewer.md",
        tools: { deny: ["write"] }, outputSchema: ${JSON.stringify(schema)}
      });
      api.registerCommand({
        name: "profile-proof", description: "Exercise a native reviewer profile",
        requireAuth: true, runtimeCapabilities: ["subagents"],
        async handler(ctx) {
          const native = ctx.runtimeContext.subagents;
          let conflict;
          try {
            await native.spawn({ requestId: "conflict", task: "Must not launch",
              profile: "reviewer", outputSchema: { type: "string" } });
          } catch (error) { conflict = String(error); }
          if (!conflict) throw new Error("Caller replaced the profile output schema");
          const accepted = [];
          for (const requestId of ["valid", "invalid"]) {
            accepted.push(await native.spawn({ requestId, task: requestId + " profile result",
              profile: "reviewer", context: "isolated" }));
          }
          const collection = await native.collect({ ids: accepted.map(child => child.runId),
            awaitResults: true });
          return { text: JSON.stringify({ conflict, accepted, collection }) };
        }
      });
    } };`,
  );
  return { root, entry };
}

export function registerDiskProfileCase(options: NativePluginSpawnTestOptions) {
  it("enforces a disk-loaded command profile through real Gateway children and collection", async () => {
    const workspace = resolveAgentWorkspaceDir(getRuntimeConfig(), "main");
    const snapshot = captureActivePluginRegistrySnapshot();
    const source = createSpawnOperatorSource();
    let registry: PluginRegistry | undefined;
    try {
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
      const tempDir = path.join(workspace, "profile-tmp");
      await fs.mkdir(tempDir, { recursive: true });
      vi.stubEnv("TMPDIR", tempDir);
      const handoff = installPrivateUpdateHandoffStore(tempDir);
      const guarded = writePrivateUpdateHandoffChildGuard(
        handoff.databasePath,
        tempDir,
      )(process.env);
      vi.stubEnv("NODE_OPTIONS", guarded.NODE_OPTIONS);
      handoff.assertDatabasePath(handoff.databasePath);
      const plugin = await writeDiskPlugin(workspace);
      const cfg = {
        ...getRuntimeConfig(),
        plugins: { allow: [pluginId], load: { paths: [plugin.entry] }, slots: { memory: "none" } },
      };
      await fs.writeFile(
        expectDefined(process.env.OPENCLAW_CONFIG_PATH, "fixture config"),
        JSON.stringify(cfg),
      );
      clearConfigCache();
      setRuntimeConfigSnapshot(cfg);
      registry = loadOpenClawPlugins({ config: cfg, activate: false, cache: false });
      setActivePluginRegistry(registry);
      await fs.writeFile(
        path.join(plugin.root, "reviewer.md"),
        "MUTATED_PROFILE_MUST_NOT_REACH_CHILD",
      );
      const bound = await options.createBoundParent(source.authority);
      const { parentSessionKey, parentRunId } = bound;
      const runEmbeddedAgent = options.runEmbeddedAgent;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: parentSessionKey },
        {
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["read", "write", "edit", "sessions_spawn", "agents_wait"],
          inheritedToolDeny: ["edit"],
        },
      );
      const { context, runtime } = await options.createBoundGateway(bound);

      const protectedFile = path.join(workspace, "protected.txt");
      await fs.writeFile(protectedFile, "unchanged proof input");
      runEmbeddedAgent.mockImplementation(async (params) => {
        const admitted = await resolvePreparedRunAdmission({
          runId: params.runId,
          runtimeKind: "embedded",
          admittedRunContext: params.admittedRunContext,
          preparedRunAdmission: params.preparedRunAdmission,
        });
        expect(readAdmittedRunOperatorAuthority(admitted)).toMatchObject({
          profileId: source.authority.profileId,
          scopes: source.authority.scopes,
        });
        expect(params.extraSystemPrompt).toContain(instructions);
        expect(params.extraSystemPrompt).not.toContain("MUTATED_PROFILE_MUST_NOT_REACH_CHILD");
        const childKey = expectDefined(params.sessionKey, "child session key");
        const child = expectDefined(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: childKey }),
          "child",
        );
        const tools = await createOpenClawCodingToolsInternalAsync({
          config: cfg,
          agentId: "main",
          sessionKey: childKey,
          sessionId: child.sessionId,
          runId: params.runId,
          workspaceDir: workspace,
          swarmCollector: params.swarmCollector,
          swarmOutputSchema: params.swarmOutputSchema,
        });
        const catalogRef = createToolSearchCatalogRef();
        registerHeadlessToolSearchCatalog({
          catalogRef,
          tools,
          hookContext: { runId: params.runId },
        });
        const dispatcher = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
        try {
          expect(await dispatcher.call("read", { path: protectedFile })).toMatchObject({
            result: {
              content: expect.arrayContaining([
                expect.objectContaining({ text: expect.stringContaining("unchanged proof input") }),
              ]),
            },
          });
          for (const tool of ["write", "edit"]) {
            await expect(
              dispatcher.callExactId(`openclaw:core:${tool}`, {
                path: protectedFile,
                content: "must not write",
                oldText: "unchanged",
                newText: "changed",
              }),
            ).rejects.toThrow(/unknown tool|not found|unavailable/i);
          }
          expect(await fs.readFile(protectedFile, "utf8")).toBe("unchanged proof input");
        } finally {
          clearToolSearchCatalog({ catalogRef });
        }
        const invalid = params.prompt.includes("invalid profile result");
        const output = expectDefined(
          tools.find((tool) => tool.name === "structured_output"),
          "collector result tool",
        );
        const value = { verdict: invalid ? "rejected" : "approved" };
        if (invalid) {
          await expect(output.execute("invalid-output", { result: value })).rejects.toThrow(
            "Retry once",
          );
          expect(await output.execute("invalid-retry", { result: value })).toMatchObject({
            details: { status: "rejected", success: false, schemaError: expect.any(String) },
          });
        } else {
          expect(await output.execute("valid-output", { result: value })).toMatchObject({
            details: { status: "recorded" },
          });
        }
        const text = JSON.stringify(value);
        await recordSpawnBoundaryFinal({
          storePath: bound.storePath,
          sessionKey: childKey,
          runId: params.runId,
          text,
        });
        return visibleResult(text);
      });

      try {
        const entry = expectDefined(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: parentSessionKey }),
          "requester",
        );
        const ctx = buildTestCtx({
          Body: "/profile-proof",
          CommandBody: "/profile-proof",
          CommandAuthorized: true,
          SessionKey: parentSessionKey,
          InputProvenance: { kind: "external_user" },
        });
        const recorder = createUserTurnTranscriptRecorder({
          input: { text: "/profile-proof" },
          target: createSpawnTranscriptTarget(bound, entry),
        });
        const invoke = (signal: AbortSignal) => {
          const nativeState: Parameters<typeof runWithCommandNativeSubagents>[0] = {
            cfg,
            ctx,
            sessionAgentId: "main",
            sessionKey: parentSessionKey,
            sessionStoreEntry: { sessionKey: parentSessionKey, entry },
            params: {
              replyOptions: {
                runId: parentRunId,
                operatorAuthority: source.authority,
                toolsAllow: ["sessions_spawn", "agents_wait", "read", "write", "edit"],
                userTurnTranscriptRecorder: recorder,
              },
            },
            getPreDispatchAbortSignal: () => undefined,
            getDispatchAbortSignal: () => signal,
            assertProgressCurrent: source.authority.assertCurrent,
            assertCurrentBindingRoute: async () => source.authority.assertCurrent(),
            turnAdoption: { assertCurrent: source.authority.assertCurrent, adopt: async () => {} },
          };
          const command = buildCommandTestParams("/profile-proof", cfg, ctx, {
            workspaceDir: workspace,
          });
          command.sessionKey = parentSessionKey;
          command.sessionEntry = entry;
          command.storePath = bound.storePath;
          command.opts = {
            withCommandNativeSubagents: (binding, run) =>
              runWithCommandNativeSubagents(nativeState, binding, run),
          };
          return handlePluginCommand(command, true);
        };
        if (!bound.parent.registered) {
          throw new Error("Requester source was not registered");
        }
        const controllerInput = bound.parent.entry.input;
        const result = await withPluginRuntimeGatewayRequestScope(
          {
            context,
            pluginRegistry: registry,
            resolveGatewayContext: bound.resolveGatewayContext,
            isWebchatConnect: () => false,
          },
          () =>
            withSessionTurn(
              {
                sessionKey: parentSessionKey,
                sessionId: entry.sessionId,
                agentId: "main",
                storePath: bound.storePath,
                controllerInput,
              },
              async (_operation, ownerSignal) =>
                invoke(AbortSignal.any([bound.parent.controller.signal, ownerSignal])),
            ),
        );
        expect(result?.shouldContinue).toBe(false);
        const receipt = JSON.parse(expectDefined(result?.reply?.text, "plugin command response"));
        expect(receipt.conflict).toMatch(/outputSchema|schema/i);
        expect(receipt.collection).toMatchObject({
          pending: [],
          completed: [
            expect.objectContaining({ status: "done", structured: { verdict: "approved" } }),
            expect.objectContaining({ status: "failed", schemaError: expect.any(String) }),
          ],
        });
        expect(receipt.collection.completed[1].structured).toBeUndefined();
      } finally {
        source.revoke();
        options.throwBoundFailures(await options.closeBoundGateway(bound, runtime));
      }
    } finally {
      source.revoke();
      source.closeRequest();
      try {
        if (registry) {
          await disposePluginRegistryInstances(registry);
        }
      } finally {
        restoreActivePluginRegistrySnapshot(snapshot);
        clearPluginRegistryLoadCache();
        // The private handoff store installs spies; do not leak its paths to the next case.
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }
  });
}
