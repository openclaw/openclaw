import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { resolveSessionWorkStartError } from "../config/sessions/session-work-start.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { completeAgentOnboarding } from "../gateway/server-methods/agents-onboarding.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { createGatewaySession } from "../gateway/session-create-service.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { withResolvedClawHubSource } from "./clawhub-source.js";
import { applyTemplateAddForGateway } from "./gateway-add-apply.js";
import { buildGatewayTemplateAddPlan, projectGatewayTemplateAddPlan } from "./gateway-add-plan.js";
import { readTemplateManifestFile } from "./reader.js";

const { resolveSource } = vi.hoisted(() => ({ resolveSource: vi.fn() }));
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});
// mock-isolation: Fixed registry artifact; planner, leases, workspace, config and canonical session writes remain real.
vi.mock("./clawhub-source.js", async (original) => ({
  ...(await original<typeof import("./clawhub-source.js")>()),
  withResolvedClawHubSource: resolveSource,
}));
// mock-isolation: No live websocket clients exist in this service-boundary scenario.
vi.mock("../gateway/server-methods/session-change-event.js", () => ({
  emitSessionsChanged: vi.fn(),
}));

it.each([
  "applied",
  "restart-required",
  "revoked",
  "abort-before-commit",
  "admitted-applied",
  "admitted-session-replaced",
] as const)(
  "prepares empty ordinary Template chat before runtime publication: %s",
  async (outcome) => {
    await withOpenClawTestState({ label: "template-agent-first-integration" }, async (state) => {
      const root = state.path("template-source");
      await fs.mkdir(root);
      await fs.writeFile(path.join(root, "SOUL.md"), "A calm fixture personality.\n");
      const manifest = path.join(root, "CLAW.md");
      await fs.writeFile(
        manifest,
        "---\n" +
          JSON.stringify({
            schemaVersion: 1,
            agent: { id: "fixture-first", name: "First Fixture" },
            workspace: { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } },
          }) +
          "\n---\n",
      );
      const source = await readTemplateManifestFile(manifest);
      if (!source.ok) {
        throw new Error("Invalid fixture manifest");
      }
      source.source = {
        ...source.source,
        kind: "package",
        name: "@fixture/template-first",
        version: "1.0.0",
        integrityKind: "artifact",
      };
      resolveSource.mockImplementation(
        async (input: Parameters<typeof withResolvedClawHubSource>[0]) => ({
          value: await input.run(
            source,
            {
              riskAcknowledgementRequired: false,
              trustRecord: {
                clawhubTrustDisposition: "clean",
                clawhubTrustCheckedAt: "2026-11-04T00:00:00.000Z",
              },
            },
            async () => source,
          ),
        }),
      );
      let sourceEntered = false;
      const sourceImplementation = resolveSource.getMockImplementation()!;
      resolveSource.mockImplementation(async (...args) => {
        sourceEntered = true;
        if (outcome === "admitted-session-replaced") {
          const key = "agent:fixture-first:main";
          const entry = loadSessionEntryReadOnly({ agentId: "fixture-first", sessionKey: key })!;
          await deleteSessionEntryLifecycle({
            agentId: "fixture-first",
            storePath: resolveSessionStorePathCore(config.session?.store, {
              agentId: "fixture-first",
            }),
            target: { canonicalKey: key, storeKeys: [key] },
            expectedSessionId: entry.sessionId,
            expectedLifecycleRevision: entry.lifecycleRevision,
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
            requireWriteSuccess: true,
          });
          const successor = await createGatewaySession({
            cfg: (await readConfigFileSnapshot()).config,
            agentId: "fixture-first",
            key,
            commandSource: "webchat",
          });
          if (!successor.ok) {
            throw new Error(successor.error.message);
          }
        }
        return sourceImplementation(...args);
      });
      let config: OpenClawConfig = {
        gateway: { controlUi: { experimental: { templates: true } } },
        agents: {
          entries: { main: { workspace: state.path("existing-workspace") } },
          defaults: { model: "ollama/test-model" },
        },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const review = outcome.startsWith("admitted-")
        ? projectGatewayTemplateAddPlan(
            await buildGatewayTemplateAddPlan(source, { config, sourceMcpServers: {} }),
            source,
            {
              riskAcknowledgementRequired: false,
              trustRecord: {
                clawhubTrustDisposition: "clean",
                clawhubTrustCheckedAt: "2026-11-04T00:00:00.000Z",
              },
            },
            config,
          )
        : undefined;
      let admittedSessionId: string | undefined;
      let current = true;
      let publicationReached = false;
      const sessionKey = "agent:fixture-first:main";
      const prepareAgentChat = vi.fn(
        async (
          agentId: string,
          prospectiveConfig: OpenClawConfig,
          pending?: { initializationPending: true },
        ) => {
          const options = {
            req: { type: "req", id: "template-add", method: "templates.add.apply" },
            context: { getRuntimeConfig: () => config },
            client: { connect: { client: { mode: "ui" }, scopes: ["operator.admin"] } },
            respond: vi.fn(),
          } as unknown as GatewayRequestHandlerOptions;
          const prepared = await completeAgentOnboarding(options, agentId, {
            config: prospectiveConfig,
            ...pending,
          });
          if (prepared.status !== "completed" || !prepared.rollback) {
            throw new Error(prepared.status === "error" ? prepared.error : "Missing rollback");
          }
          return prepared.rollback;
        },
      );
      const onAgentReady = vi.fn(async () => {
        expect(publicationReached).toBe(true);
        expect(config.agents?.entries).toHaveProperty("fixture-first");
        const initialized = loadSessionEntryReadOnly({ agentId: "fixture-first", sessionKey });
        expect(initialized?.initializationPending).toBeUndefined();
        if (admittedSessionId) {
          expect(initialized?.sessionId).toBe(admittedSessionId);
        }
        expect(
          await fs.readFile(
            path.join(config.agents!.entries!["fixture-first"]!.workspace!, "SOUL.md"),
            "utf8",
          ),
        ).toBe("A calm fixture personality.\n");
      });
      const result = await applyTemplateAddForGateway({
        source: { packageName: "@fixture/template-first", version: "1.0.0" },
        ...(outcome.startsWith("admitted-")
          ? { agentId: "fixture-first", planIntegrity: review!.planIntegrity }
          : {}),
        getPlanningContext: async () => ({ config, sourceMcpServers: {} }),
        policyConfig: { configPath: state.configPath, env: state.env },
        configWriteOptions: {
          beforeCommit: async () => {
            if (outcome === "abort-before-commit") {
              throw new Error("Fixture config admission refused");
            }
          },
        },
        assertCurrent: () => {
          if (!current) {
            throw new Error("Fixture authority expired");
          }
        },
        prepareAgentChat,
        waitForAgentRuntime: async () => {
          const entry = loadSessionEntryReadOnly({ agentId: "fixture-first", sessionKey });
          expect(entry?.sessionId).toBeTruthy();
          const events = await loadTranscriptEvents({
            agentId: "fixture-first",
            sessionKey,
            sessionId: entry!.sessionId,
          });
          expect(events.map(readTranscriptEventMessage).filter(Boolean)).toEqual([]);
          if (!sourceEntered) {
            expect(entry?.initializationPending).toBe(true);
            admittedSessionId = entry!.sessionId;
            expect(resolveSessionWorkStartError(sessionKey, entry)).toContain("still initializing");
            config = (await readConfigFileSnapshot()).config;
            setRuntimeConfigSnapshot(config);
            return "applied";
          }
          publicationReached = true;
          config = (await readConfigFileSnapshot()).config;
          setRuntimeConfigSnapshot(config);
          if (outcome === "revoked") {
            current = false;
          }
          return outcome === "restart-required" ? "applied-restart-required" : "applied";
        },
        onAgentReady,
      });
      expect(prepareAgentChat).toHaveBeenCalledOnce();
      if (outcome === "admitted-session-replaced") {
        expect(result).toMatchObject({
          status: "partial",
          agentRetained: true,
          initializationPending: true,
        });
        expect(result.error?.message).toContain("pending ordinary session changed");
        expect(
          loadSessionEntryReadOnly({ agentId: "fixture-first", sessionKey })?.sessionId,
        ).not.toBe(admittedSessionId);
        expect(
          loadSessionEntryReadOnly({ agentId: "fixture-first", sessionKey })?.initializationPending,
        ).toBeUndefined();
        expect(
          await fs.readdir(config.agents!.entries!["fixture-first"]!.workspace!),
        ).not.toContain("SOUL.md");
        expect(onAgentReady).not.toHaveBeenCalled();
        return;
      }
      if (outcome === "abort-before-commit") {
        expect(result).toMatchObject({ status: "partial" });
        expect(publicationReached).toBe(false);
        expect((await readConfigFileSnapshot()).config.agents?.entries).not.toHaveProperty(
          "fixture-first",
        );
        expect(loadSessionEntryReadOnly({ agentId: "fixture-first", sessionKey })).toBeUndefined();
      } else {
        expect(publicationReached).toBe(true);
        expect(config.agents?.entries).toHaveProperty("fixture-first");
        expect(
          loadSessionEntryReadOnly({ agentId: "fixture-first", sessionKey })?.sessionId,
        ).toBeTruthy();
        expect(result).toMatchObject({
          agentId: "fixture-first",
          status: outcome === "applied" || outcome === "admitted-applied" ? "complete" : "partial",
        });
        expect(result.sessionKey).toBe(sessionKey);
        if (outcome !== "applied" && outcome !== "admitted-applied") {
          expect(result.agentRetained).toBe(true);
        }
      }
      expect(onAgentReady).toHaveBeenCalledTimes(
        outcome === "applied" || outcome === "admitted-applied" ? 1 : 0,
      );
    });
  },
);

it("publishes the ordinary durable agent and empty canonical chat before resolving Template source", async () => {
  await withOpenClawTestState({ label: "template-before-source" }, async (state) => {
    const config: OpenClawConfig = {
      gateway: { controlUi: { experimental: { templates: true } } },
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: state.path("existing-workspace") },
          existing: { workspace: state.path("existing-other-workspace") },
        },
        defaults: { model: "ollama/test-model" },
      },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    const entered = Promise.withResolvers<void>();
    const source = Promise.withResolvers<never>();
    resolveSource.mockImplementation(async () => {
      entered.resolve();
      return await source.promise;
    });
    const onAgentReady = vi.fn();
    const prepareAgentChat = vi.fn(
      async (
        agentId: string,
        prospectiveConfig: OpenClawConfig,
        pending?: { initializationPending: true },
      ) => {
        const prepared = await completeAgentOnboarding(
          {
            req: { type: "req", id: "template-held", method: "templates.add.apply" },
            context: { getRuntimeConfig: () => config },
            client: { connect: { client: { mode: "ui" }, scopes: ["operator.admin"] } },
            respond: vi.fn(),
          } as unknown as GatewayRequestHandlerOptions,
          agentId,
          { config: prospectiveConfig, ...pending },
        );
        if (prepared.status !== "completed" || !prepared.rollback) {
          throw new Error("Session preparation failed");
        }

        return prepared.rollback;
      },
    );
    const existing = await createGatewaySession({
      cfg: config,
      agentId: "main",
      key: "agent:main:existing-fixture",
      commandSource: "webchat",
      requestingOperatorScopes: ["operator.admin"],
      creation: { via: "operator" },
    });
    if (!existing.ok) {
      throw new Error("Cannot initialize existing Gateway state");
    }
    const baseline = (await readConfigFileSnapshot()).config;
    expect(Object.keys(baseline.agents!.entries!)).toEqual(["main", "existing"]);
    expect(baseline.agents!.ownership).toBe("explicit");
    const applying = applyTemplateAddForGateway({
      source: { packageName: "@fixture/template-first", version: "1.0.0" },
      agentId: "fixture-first",
      getPlanningContext: async () => ({
        config: (await readConfigFileSnapshot()).config,
        sourceMcpServers: {},
      }),
      policyConfig: { configPath: state.configPath, env: state.env },
      assertCurrent: () => {},
      prepareAgentChat,
      waitForAgentRuntime: async () => "applied",
      onAgentReady,
    });
    const settled = applying.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await Promise.race([
      entered.promise,
      settled.then((result) => {
        throw new Error("Add settled before source: " + JSON.stringify(result));
      }),
    ]);
    try {
      const stored = (await readConfigFileSnapshot()).config;
      expect(stored.agents?.entries).toHaveProperty("fixture-first");
      const entry = loadSessionEntryReadOnly({
        agentId: "fixture-first",
        sessionKey: "agent:fixture-first:main",
      });
      expect(entry?.sessionId).toBeTruthy();
      expect(entry?.initializationPending).toBe(true);
      expect(resolveSessionWorkStartError("agent:fixture-first:main", entry)).toContain(
        "still initializing",
      );
      const events = await loadTranscriptEvents({
        agentId: "fixture-first",
        sessionKey: "agent:fixture-first:main",
        sessionId: entry!.sessionId,
      });
      expect(events.map(readTranscriptEventMessage).filter(Boolean)).toEqual([]);
      expect(await fs.readdir(stored.agents!.entries!["fixture-first"]!.workspace!)).not.toContain(
        "SOUL.md",
      );
      expect(onAgentReady).not.toHaveBeenCalled();
    } finally {
      source.reject(new Error("Fixture source verification rejected"));
      await settled;
    }
    expect(await settled).toMatchObject({
      value: {
        status: "partial",
        agentId: "fixture-first",
        agentRetained: true,
        sessionKey: "agent:fixture-first:main",
      },
    });
    expect((await readConfigFileSnapshot()).config.agents?.entries).toHaveProperty("fixture-first");
    expect(prepareAgentChat).toHaveBeenCalledOnce();
  });
});
