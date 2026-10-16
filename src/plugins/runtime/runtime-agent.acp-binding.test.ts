import { describe, expect, it, vi } from "vitest";
import * as acpSessionMeta from "../../acp/runtime/session-meta.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

describe("plugin runtime ACP session creation", () => {
  it("does not initialize or remove a successor observed after ACP preparation", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-acp-successor" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:plugin:acpx:catalog-adopt:pi:source";
      let successor: ReturnType<typeof runtime.session.getSessionEntry>;
      const upsert = acpSessionMeta.upsertAcpSessionMeta;
      const prepare = vi
        .spyOn(acpSessionMeta, "upsertAcpSessionMeta")
        .mockImplementationOnce(async (params) => {
          const prepared = await upsert(params);
          expect(prepared?.acp).toMatchObject({ backend: "acpx", agent: "pi" });
          const current = runtime.session.getSessionEntry({
            sessionKey: key,
            readConsistency: "latest",
          });
          if (!current) {
            throw new Error("expected the freshly created ACP child");
          }
          const replacement = await replaceSessionEntry(
            { agentId: "main", sessionKey: key },
            {
              ...current,
              sessionId: "successor",
              lifecycleRevision: "successor-generation",
            },
          );
          if (!replacement) {
            throw new Error("expected the successor to replace the prepared ACP child");
          }
          successor = replacement;
          return prepared;
        });
      const afterCreate = vi.fn(async () => {
        throw new Error("initializer must not receive a successor");
      });
      try {
        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            initialEntry: {
              acpBackendId: "acpx",
              acpSessionBinding: { acpAgentId: "pi", agentSessionId: "pi-source" },
              pluginOwnerId: "acpx",
            },
            afterCreate,
          }),
        ).rejects.toThrow();
        expect(successor).toMatchObject({
          sessionId: "successor",
          lifecycleRevision: "successor-generation",
        });
        expect(afterCreate).not.toHaveBeenCalled();
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toEqual(successor);
      } finally {
        prepare.mockRestore();
      }
    });
  });

  it("persists a plugin-owned native resume binding", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-acp-session-create" }, async () => {
      const runtime = createRuntimeAgent();
      const created = await runtime.session.createSessionEntry({
        cfg: {},
        key: "plugin:acpx:catalog-adopt:pi:source",
        label: "Pi source",
        spawnedCwd: "/workspace/pi",
        initialEntry: {
          acpBackendId: "acpx",
          acpSessionBinding: { acpAgentId: "pi", agentSessionId: "pi-source" },
          pluginOwnerId: "acpx",
        },
      });

      expect(created.entry).toMatchObject({
        createdVia: "plugin",
        createdActor: { type: "system", id: "acpx" },
        pluginOwnerId: "acpx",
        label: "Pi source",
        spawnedCwd: "/workspace/pi",
      });
      expect(created.entry.initializationPending).toBeUndefined();
      expect(
        acpSessionMeta.readAcpSessionEntry({ cfg: {}, sessionKey: created.key })?.acp,
      ).toMatchObject({
        backend: "acpx",
        agent: "pi",
        runtimeSessionName: created.key,
        identity: {
          state: "resolved",
          agentSessionId: "pi-source",
          source: "ensure",
        },
        mode: "persistent",
        cwd: "/workspace/pi",
        state: "idle",
      });
    });
  });

  it("rejects recovery when the native resume binding differs", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-acp-recovery-binding" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:plugin:opencode:catalog-adopt:source";
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
      await runtime.session.upsertSessionEntry({
        storePath,
        sessionKey: key,
        entry: {
          sessionId: "interrupted-acp-initializer",
          updatedAt: Date.now(),
          delivery: { kind: "none" },
          initializationPending: true,
          pluginOwnerId: "opencode",
          spawnedCwd: "/workspace/opencode",
          acpSessionBinding: {
            acpBackendId: "acpx",
            acpAgentId: "opencode",
            agentSessionId: "expected-source",
          },
        },
      });
      await acpSessionMeta.upsertAcpSessionMeta({
        cfg: {},
        sessionKey: key,
        mutate: () => ({
          backend: "acpx",
          agent: "opencode",
          runtimeSessionName: key,
          identity: {
            state: "resolved",
            agentSessionId: "different-source",
            source: "ensure",
            lastUpdatedAt: Date.now(),
          },
          mode: "persistent",
          cwd: "/workspace/opencode",
          state: "idle",
          lastActivityAt: Date.now(),
        }),
      });
      const storedBeforeRecovery = runtime.session.getSessionEntry({
        sessionKey: key,
        readConsistency: "latest",
      });
      const afterCreate = vi.fn(async () => ({ pluginExtensions: {} }));

      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          spawnedCwd: "/workspace/opencode",
          recoverMatchingInitialEntry: true,
          initialEntry: {
            acpBackendId: "acpx",
            acpSessionBinding: {
              acpAgentId: "opencode",
              agentSessionId: "expected-source",
            },
            pluginOwnerId: "opencode",
          },
          afterCreate,
        }),
      ).rejects.toThrow("does not match its trusted recovery state");
      expect(afterCreate).not.toHaveBeenCalled();
      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toEqual(storedBeforeRecovery);
    });
  });

  it("recovers an interrupted ACP initializer before metadata was seeded", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-acp-recovery-missing-meta" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:plugin:acpx:catalog-adopt:pi:recovery";
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
      const marker = { acpx: { piSessionCatalog: { sourceThreadId: "pi-source" } } };
      await runtime.session.upsertSessionEntry({
        storePath,
        sessionKey: key,
        entry: {
          sessionId: "interrupted-before-acp-meta",
          updatedAt: Date.now(),
          delivery: { kind: "none" },
          initializationPending: true,
          pluginOwnerId: "acpx",
          spawnedCwd: "/workspace/pi",
          pluginExtensions: marker,
          acpSessionBinding: {
            acpBackendId: "acpx",
            acpAgentId: "pi",
            agentSessionId: "pi-source",
          },
        },
      });

      const recovered = await runtime.session.createSessionEntry({
        cfg: {},
        key,
        spawnedCwd: "/workspace/pi",
        recoverMatchingInitialEntry: true,
        initialEntry: {
          acpBackendId: "acpx",
          acpSessionBinding: { acpAgentId: "pi", agentSessionId: "pi-source" },
          pluginOwnerId: "acpx",
          pluginExtensions: marker,
        },
        afterCreate: async () => ({ pluginExtensions: marker }),
      });

      expect(recovered.entry.initializationPending).toBeUndefined();
      expect(recovered.entry.acpSessionBinding).toBeUndefined();
      expect(acpSessionMeta.readAcpSessionEntry({ cfg: {}, sessionKey: key })?.acp).toMatchObject({
        backend: "acpx",
        agent: "pi",
        identity: { agentSessionId: "pi-source" },
      });
    });
  });
});
