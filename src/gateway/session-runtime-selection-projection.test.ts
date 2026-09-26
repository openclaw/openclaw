import { describe, expect, it } from "vitest";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { projectChatSessionMetadata } from "./server-methods/chat-metadata-session-projection.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { projectSessionPatchResult } from "./session-utils-model.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

const catalog = [
  { provider: "openai", id: "gpt-5.6-sol", name: "Sol", reasoning: true },
  { provider: "openai", id: "gpt-5.6-luna", name: "Luna", reasoning: true },
];

describe("session runtime selection ownership projection", () => {
  it.each([
    { kind: "acp", key: "agent:main:main", locked: true },
    { kind: "native-lock", key: "agent:main:locked", locked: true },
    { kind: "locked-harness", key: "agent:main:locked-harness", locked: true },
    { kind: "locked-override", key: "agent:main:locked-override", locked: true },
    { kind: "historical-harness", key: "agent:main:historical-harness", locked: false },
    { kind: "acp-locked-harness", key: "agent:main:acp:locked-harness", locked: true },
    { kind: "runtime-pin", key: "agent:main:pinned", locked: false },
    { kind: "key-only", key: "agent:main:acp:no-owner", locked: false },
    { kind: "replaced-acp", key: "agent:main:replaced", locked: false },
  ])(
    "projects $kind from the authoritative row through all client surfaces",
    async ({ kind, key, locked }) => {
      await withOpenClawTestState(
        { scenario: "minimal", label: "runtime-selection-owner" },
        async (state) => {
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                model: "openai/gpt-5.6-sol",
                models: {
                  "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
                  "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
                },
              },
            },
          };
          const modelLocked = [
            "native-lock",
            "locked-harness",
            "locked-override",
            "acp-locked-harness",
          ].includes(kind);
          let entry: SessionEntry = {
            sessionId: "current-session",
            lifecycleRevision: "current-revision",
            updatedAt: 1,
            ...(modelLocked ? { modelSelectionLocked: true } : {}),
            ...(["locked-harness", "historical-harness", "acp-locked-harness"].includes(kind)
              ? { agentHarnessId: "codex" }
              : {}),
            ...(kind === "runtime-pin" || kind === "locked-override"
              ? { agentRuntimeOverride: "codex" }
              : {}),
            thinkingLevel: "high",
          };
          const scope = { agentId: "main", sessionKey: key, env: state.env };
          await upsertSessionEntryCore(scope, entry);
          if (kind === "acp" || kind === "replaced-acp" || kind === "acp-locked-harness") {
            await upsertAcpSessionMeta({
              cfg,
              agentId: "main",
              sessionKey: key,
              env: state.env,
              mutate: () => ({
                backend: "acpx",
                agent: "main",
                runtimeSessionName: key,
                mode: "persistent",
                state: "idle",
                lastActivityAt: 1,
              }),
            });
          }
          if (kind === "replaced-acp") {
            entry = { ...entry, lifecycleRevision: "replacement-revision" };
            await upsertSessionEntryCore(scope, entry);
          }
          const row = buildGatewaySessionRow({
            cfg,
            agentId: "main",
            key,
            entry,
            store: { [key]: entry },
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
            modelCatalog: catalog,
            lightweightListRow: true,
            skipTranscriptUsageFallback: true,
          });
          expect(row.runtimeSelectionLocked).toBe(locked);
          expect(row.modelSelectionLocked).toBe(modelLocked ? true : undefined);
          if (kind === "runtime-pin") {
            expect(row.agentRuntime?.source).toBe("session-key");
          }
          const metadata = projectChatSessionMetadata(
            { agentId: "main", sessionKey: key, sessionEntry: entry },
            { models: [], swarmEnabled: false },
            cfg,
          );
          expect(metadata.runtimeSelectionLocked).toBe(locked);
          const patched = projectSessionPatchResult({
            cfg,
            canonicalKey: key,
            entry,
            targetAgentId: "main",
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
            modelCatalog: catalog,
          });
          expect(patched.resolved?.runtimeSelectionLocked).toBe(locked);
          const expectedRuntime =
            kind === "locked-harness" || kind === "locked-override"
              ? { id: "codex", source: "session" }
              : kind === "acp-locked-harness"
                ? { id: "acpx", source: "session-key" }
                : kind === "historical-harness"
                  ? { id: "openclaw", source: "model" }
                  : undefined;
          if (expectedRuntime) {
            expect(row.agentRuntime).toMatchObject(expectedRuntime);
            expect(patched.resolved?.agentRuntime).toEqual(expectedRuntime);
          }
          expect(row.thinkingLevel).toBe("high");
          expect(patched.resolved?.thinkingLevel).toBe("high");
          expect(buildGatewaySessionSnapshot({ sessionRow: row }).runtimeSelectionLocked).toBe(
            locked,
          );
          const lifecycle = buildGatewaySessionSnapshot({
            sessionRow: row,
            includeSession: true,
            lifecycle: true,
          });
          expect(lifecycle).not.toHaveProperty("runtimeSelectionLocked");
          expect(lifecycle).not.toHaveProperty("session.runtimeSelectionLocked");
          if (kind === "acp") {
            const project = (patch: { model?: string; agentRuntime?: null }) =>
              projectSessionsPatchEntry({
                cfg,
                storeKey: key,
                agentId: "main",
                existingEntry: entry,
                isLabelInUse: () => false,
                patch: { key, ...patch },
                loadGatewayModelCatalogSnapshot: async () => ({
                  entries: catalog,
                  routeVariants: catalog,
                }),
              });
            expect(await project({ model: "openai/gpt-5.6-luna" })).toMatchObject({
              ok: true,
              entry: { modelOverride: "gpt-5.6-luna" },
            });
            expect(
              await project({ model: "openai/gpt-5.6-luna", agentRuntime: null }),
            ).toMatchObject({
              ok: false,
              error: { message: "Runtime selection is owned by this ACP session." },
            });
          }
        },
      );
    },
  );
});
