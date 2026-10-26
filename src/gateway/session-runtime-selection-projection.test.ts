import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatMetadataHarness } from "./server-methods/chat-metadata-runtime.test-support.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { projectSessionPatchResult } from "./session-utils-model.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

const catalog = [
  { provider: "openai", id: "gpt-5.6-sol", name: "Sol", reasoning: true },
  { provider: "openai", id: "gpt-5.6-luna", name: "Luna", reasoning: true },
];

it.each([
  { kind: "acp", key: "agent:main:main", locked: true },
  { kind: "locked-harness", key: "agent:main:locked-harness", locked: true },
  { kind: "locked-override", key: "agent:main:locked-override", locked: true },
  { kind: "historical-harness", key: "agent:main:historical-harness", locked: false },
  { kind: "acp-locked-harness", key: "agent:main:acp:locked-harness", locked: true },
  { kind: "runtime-pin", key: "agent:main:pinned", locked: false },
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
        setRuntimeConfigSnapshot(cfg);
        const acp = kind === "acp" || kind === "acp-locked-harness";
        const modelLocked = locked && kind !== "acp";
        const entry: SessionEntry = {
          sessionId: "current-session",
          lifecycleRevision: "current-revision",
          updatedAt: 1,
          ...(modelLocked ? { modelSelectionLocked: true } : {}),
          ...(kind.includes("harness") ? { agentHarnessId: "codex" } : {}),
          ...(kind === "runtime-pin" || kind === "locked-override"
            ? { agentRuntimeOverride: "codex" }
            : {}),
          thinkingLevel: "high",
        };
        const scope = { agentId: "main", sessionKey: key, env: state.env };
        await upsertSessionEntryCore(scope, entry);
        if (acp) {
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
        const [acpMeta] = await readAcpSessionMetaForEntries({
          cfg,
          entries: [{ agentId: "main", sessionKey: key, entry }],
        });
        const projection = {
          cfg,
          agentId: "main",
          key,
          entry,
          preparedAcpMeta: acpMeta ?? null,
          storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
          modelCatalog: catalog,
        };
        const row = buildGatewaySessionRow({
          ...projection,
          store: { [key]: entry },
          lightweightListRow: true,
        });
        const selection = { runtimeSelectionLocked: locked, thinkingLevel: "high" };
        expect(row).toMatchObject(selection);
        expect(row.modelSelectionLocked).toBe(modelLocked ? true : undefined);
        if (kind === "runtime-pin") {
          expect(row.agentRuntime?.source).toBe("session-key");
        }
        const metadata = createChatMetadataHarness(cfg);
        await metadata.runtime.refresh();
        const hostSql = observeHostDataSql();
        try {
          const params = { agentId: "main", sessionKey: key, sessionEntry: entry };
          expect((await metadata.runtime.read(params)).runtimeSelectionLocked).toBe(locked);
          const startup = await metadata.runtime.readStartup({ ...params, readPolicy: "ready" });
          expect(startup?.metadata).toBeUndefined();
          expect(hostSql.queries.filter((sql) => /\bacp_sessions\b/i.test(sql))).toEqual([]);
        } finally {
          hostSql.restore();
          await metadata.runtime.stop();
        }
        const patched = projectSessionPatchResult({
          ...projection,
          canonicalKey: key,
          targetAgentId: "main",
        });
        expect(patched.resolved).toMatchObject(selection);
        const expectedRuntime = modelLocked
          ? { id: acp ? "acpx" : "codex", source: acp ? "session-key" : "session" }
          : kind === "historical-harness"
            ? { id: "openclaw", source: "model" }
            : undefined;
        if (expectedRuntime) {
          expect(row.agentRuntime).toMatchObject(expectedRuntime);
          expect(patched.resolved?.agentRuntime).toEqual(expectedRuntime);
        }
        expect(buildGatewaySessionSnapshot({ sessionRow: row }).runtimeSelectionLocked).toBe(
          locked,
        );
        const lifecycle = buildGatewaySessionSnapshot({
          sessionRow: row,
          lifecycle: true,
        });
        expect(lifecycle).not.toHaveProperty("runtimeSelectionLocked");
        expect(lifecycle).not.toHaveProperty("session.runtimeSelectionLocked");
        if (kind === "acp") {
          expect(
            await projectSessionsPatchEntry({
              cfg,
              storeKey: key,
              agentId: "main",
              existingEntry: entry,
              isLabelInUse: () => false,
              patch: { key, model: "openai/gpt-5.6-luna" },
              loadGatewayModelCatalogSnapshot: async () => ({
                entries: catalog,
                routeVariants: catalog,
              }),
            }),
          ).toMatchObject({
            ok: true,
            entry: { modelOverride: "gpt-5.6-luna" },
          });
        }
      },
    );
  },
);
