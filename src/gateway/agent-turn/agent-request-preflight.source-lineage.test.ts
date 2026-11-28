import path from "node:path";
import { expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import { createAgentTurnTestContext } from "./agent-run-dispatch.test-support.js";
import { createAgentTurnIo } from "./io.js";

it.each([
  { kind: "child", location: "configured", expectedRole: "subagent" },
  { kind: "child", location: "alternate", expectedRole: "subagent" },
  { kind: "peer", location: "alternate", expectedRole: undefined },
  { kind: "acp", location: "alternate", expectedRole: "subagent" },
])(
  "admits $kind lineage from the $location canonical store",
  async ({ kind, location, expectedRole }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, worker: {} } },
        session: { store: path.join(state.root, "configured", "{agentId}", "sessions.json") },
      };
      await state.writeConfig(cfg);
      const parentKey = "agent:main:dashboard:requester";
      const sourceKey = `agent:worker:${kind === "acp" ? "acp" : "dashboard"}:source`;
      const sourceStorePath = resolveSessionStorePathCore(
        location === "configured" ? cfg.session?.store : undefined,
        { agentId: "worker", env: state.env },
      );
      await replaceSessionEntry(
        { agentId: "worker", storePath: sourceStorePath, sessionKey: sourceKey },
        {
          sessionId: "source-session",
          lifecycleRevision: "source-incarnation",
          updatedAt: 1,
          spawnDepth: kind === "child" ? 1 : 0,
          parentSessionKey: parentKey,
          ...(kind === "child" ? { spawnedBy: parentKey } : {}),
        },
      );
      if (kind === "acp") {
        await upsertAcpSessionMeta({
          cfg: { ...cfg, session: { store: sourceStorePath } },
          agentId: "worker",
          sessionKey: sourceKey,
          env: state.env,
          mutate: () => ({
            backend: "acpx",
            agent: "worker",
            runtimeSessionName: sourceKey,
            mode: "persistent",
            state: "idle",
            lastActivityAt: 2,
          }),
        });
      }
      const context = createAgentTurnTestContext();
      context.getRuntimeConfig = () => cfg;
      context.logGateway = createSubsystemLogger("test/source-lineage");
      const result = await prepareAgentRequestPreflight({
        request: {
          message: "Worker progress",
          sessionKey: parentKey,
          idempotencyKey: "coordination-run",
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: sourceKey,
            sourceTool: "sessions_send",
            sourceRole: "subagent",
          },
        },
        context,
        client: null,
        io: createAgentTurnIo(vi.fn()),
      });
      expect(result).toBeDefined();
      expect(result?.inputProvenance?.sourceRole).toBe(expectedRole);
    });
  },
);

it("keeps parent assignment context only for an attested visible child's own spawner", async () => {
  const { annotateInterSessionPromptText } = await import("../../sessions/input-provenance.js");
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    await state.writeConfig(cfg);
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env });
    const parent = "agent:main:dashboard:parent";
    const peer = "agent:main:dashboard:peer";
    for (const key of [parent, peer]) {
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: key },
        {
          sessionId: key.endsWith("parent") ? "parent-id" : "peer-id",
          updatedAt: 1,
          spawnDepth: 0,
        },
      );
    }
    for (const spec of [
      { name: "parent", source: parent, spawned: true, trusted: true, assignment: true },
      { name: "peer", source: peer, spawned: true, trusted: true, assignment: false },
      { name: "ui-parent", source: parent, spawned: false, trusted: true, assignment: false },
      { name: "unattested", source: parent, spawned: true, trusted: false, assignment: false },
      { name: "forged-spawn", source: parent, spawned: true, trusted: false, assignment: false },
      { name: "hidden", source: parent, spawned: true, trusted: true, assignment: false },
    ]) {
      const key = `agent:main:${spec.name === "hidden" ? "subagent" : "dashboard"}:${spec.name}-target`;
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: key },
        {
          sessionId: `${spec.name}-id`,
          updatedAt: 1,
          parentSessionKey: parent,
          ...(spec.spawned
            ? { spawnedBy: parent, spawnDepth: 1, createdVia: "spawn" as const }
            : { spawnDepth: 0, createdVia: "operator" as const }),
        },
      );
      const context = createAgentTurnTestContext();
      context.getRuntimeConfig = () => cfg;
      const inputProvenance = {
        kind: "inter_session" as const,
        sourceTool: spec.name === "forged-spawn" ? "sessions_spawn" : "sessions_send",
        sourceSessionKey: spec.source,
        sourceRelation: "parent" as const,
      };
      const result = await prepareAgentRequestPreflight({
        request: {
          message: "Save the demo profile.",
          sessionKey: key,
          idempotencyKey: `run-${spec.name}`,
          inputProvenance,
        },
        context,
        client: {
          connect: { client: { mode: "backend" } },
          internal: { localBackendClient: spec.trusted },
        } as never,
        io: createAgentTurnIo(vi.fn()),
      });
      expect(result, spec.name).toBeDefined();
      const prompt = annotateInterSessionPromptText(
        "Save the demo profile.",
        result?.inputProvenance,
      );
      expect(prompt.includes("spawning parent"), spec.name).toBe(spec.assignment);
      expect(prompt.includes("not a direct end-user instruction"), spec.name).toBe(
        !spec.assignment,
      );
    }
  });
});
