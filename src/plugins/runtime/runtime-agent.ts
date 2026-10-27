import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentIds,
} from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  resolveEmbeddedCliBackendDispatchEligibility,
  resolveEmbeddedCliBackendDispatchEligibilityAsync,
} from "../../agents/embedded-agent-runner/cli-backend-dispatch-eligibility.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import {
  buildConfiguredModelCatalog,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import {
  concretizeAgentRuntime,
  resolveEffectiveAgentRuntime,
} from "../../agents/thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { normalizeThinkLevel, resolveThinkingProfile } from "../../auto-reply/thinking.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as session from "../../config/sessions/lifecycle.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  listSessionEntriesCore as listAccessorSessionEntries,
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import { captureMemoryExactSessionReader } from "../../config/sessions/session-accessor.memory-exact-read.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  getSessionEntryAsync,
  getSessionEntryByIdAsync,
  toSessionAccessScope,
} from "../../plugin-sdk/session-store-runtime-internal.js";
import {
  listSessionEntriesAsync,
  withSessionEntriesAsync,
  patchSessionEntry,
  prepareSessionEntryPatch,
  updateSessionStoreEntry,
  upsertSessionEntry,
} from "../../plugin-sdk/session-store-runtime.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { warnPluginSdkDeprecation } from "../sdk-deprecation.js";
import { resolveAgentCatalogCreateTarget } from "./runtime-agent-session-catalog.js";
import { createRuntimeSessionEntry } from "./runtime-agent-session-create.js";
import { ensurePluginAgentWorkspace } from "./runtime-agent-workspace.js";
import { defineCachedValue } from "./runtime-cache.js";
import type { PluginRuntime } from "./types.js";

type RuntimeSession = PluginRuntime["agent"]["session"];
type RuntimeSessionStoreReadParams = Parameters<RuntimeSession["getSessionEntry"]>[0];

const loadEmbeddedAgentRuntime = createLazyRuntimeModule(
  () => import("./runtime-embedded-agent.runtime.js"),
);
const loadAgentCommandRuntime = createLazyRuntimeModule(async () => {
  const [command, identity] = await Promise.all([
    import("../../agents/agent-command.js"),
    import("../../agents/agent-command-execution-identity.js"),
  ]);
  return { command, identity };
});

function getSessionEntry(params: RuntimeSessionStoreReadParams): SessionEntry | undefined {
  warnPluginSdkDeprecation({
    family: "session-store",
    method: "runtime.agent.session.getSessionEntry",
    replacement: "runtime.agent.session.getSessionEntryAsync",
  });
  return loadSessionEntryReadOnly(toSessionAccessScope(params));
}

const listSessionEntries: RuntimeSession["listSessionEntries"] = (params = {}) => {
  warnPluginSdkDeprecation({
    family: "session-store",
    method: "runtime.agent.session.listSessionEntries",
    replacement: "runtime.agent.session.listSessionEntriesAsync",
  });
  const listEntries = params.readOnly
    ? listAccessorSessionEntriesReadOnly
    : listAccessorSessionEntries;
  return listEntries({
    ...(params.sessionKeys !== undefined ? { sessionKeys: params.sessionKeys } : {}),
    ...(params.includeParticipants !== undefined
      ? { includeParticipants: params.includeParticipants }
      : {}),
    ...(params.captureSource ? { captureSource: params.captureSource } : {}),
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  });
};

async function runWithSessionWorkAdmission<T>(
  input: { storePath: string; sessionKey: string; signal?: AbortSignal },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const params = { ...input };
  const memory = captureMemoryExactSessionReader(params, () => params.signal?.throwIfAborted());
  if (memory) {
    return admit(memory.read(params.sessionKey, "list"), () =>
      memory.read(params.sessionKey, "list"),
    );
  }
  return runAdmittedWork();

  async function runAdmittedWork(): Promise<T> {
    return withSessionEntryReadOnlyInWorker(
      {
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        readConsistency: "latest",
      },
      () => params.signal?.throwIfAborted(),
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        const initialEntry = read.value;
        const retained = owner.source?.databaseIdentity
          ? retainPreparedSessionEntryPredicate({
              databaseIdentity: `file:${owner.source.databaseIdentity}`,
              sessionKey: owner.scope?.sessionKey ?? params.sessionKey,
              entry: initialEntry,
              matches: (before, after) =>
                before?.sessionId === after?.sessionId &&
                before?.lifecycleRevision === after?.lifecycleRevision,
            })
          : undefined;
        try {
          return await admit(initialEntry, () => {
            owner.assertCurrent();
            const current = retained?.readCurrent();
            if (retained && !current) {
              throw session.createSessionWorkStartChangedError(params.sessionKey);
            }
            return current ? current.entry : initialEntry;
          });
        } finally {
          retained?.release();
        }
      },
    );
  }

  async function admit(
    initialEntry: SessionEntry | undefined,
    readCurrentEntry: () => SessionEntry | undefined,
  ): Promise<T> {
    const agentId = resolveSessionAgentIds({
      config: getRuntimeConfig(),
      sessionKey: params.sessionKey,
    }).sessionAgentId;
    const target = captureSessionTarget({
      storeScope: params.storePath,
      sessionKey: params.sessionKey,
      incarnation: initialEntry?.sessionId,
      agentId,
    });
    return await withSessionTurn(
      {
        target,
        sessionKey: params.sessionKey,
        sessionId: initialEntry?.sessionId,
        agentId,
        abortSignal: params.signal,
      },
      async (operation, turnSignal) => {
        const interruption = new AbortController();
        const signal = AbortSignal.any([turnSignal, interruption.signal]);
        const effect = await beginSessionEffect({
          target,
          operation,
          agentId,
          signal,
          onInterrupt: (reason) =>
            interruption.abort(
              reason ?? new Error("Agent work interrupted by a session lifecycle change."),
            ),
          assertAllowed: () => {
            const currentEntry = readCurrentEntry();
            if (memory) {
              const changed = initialEntry
                ? !currentEntry || currentEntry.sessionId !== initialEntry.sessionId
                : Boolean(currentEntry);
              if (changed) {
                throw session.createSessionWorkStartChangedError(params.sessionKey);
              }
            }
            const startError = session.resolveSessionWorkStartError(
              params.sessionKey,
              currentEntry,
            );
            if (startError) {
              throw new Error(startError);
            }
          },
        });
        try {
          // Nested mutations exclude this callback's own retained effect from drain.
          return await effect.run(async () => await run(signal));
        } finally {
          effect.release();
        }
      },
    );
  }
}

export function createRuntimeAgent(): PluginRuntime["agent"] {
  const agentRuntime = {
    defaults: { model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER },
    resolveAgentDir,
    resolveAgentWorkspaceDir,
    resolveAgentIdentity,
    resolveSessionCatalogCreateTarget: resolveAgentCatalogCreateTarget,
    resolveThinkingDefault,
    normalizeThinkingLevel: normalizeThinkLevel,
    resolveThinkingPolicy: (params) => {
      const cfg = getRuntimeConfig();
      const effectiveRuntime = params.agentRuntime
        ? concretizeAgentRuntime(params.agentRuntime)
        : params.provider && params.model
          ? resolveEffectiveAgentRuntime({
              cfg,
              provider: params.provider,
              modelId: params.model,
            })
          : undefined;
      const catalog = params.catalog ?? buildConfiguredModelCatalog({ cfg: getRuntimeConfig() });
      const profile = resolveThinkingProfile({
        ...params,
        agentRuntime: effectiveRuntime,
        catalog: params.catalog ?? (catalog.length > 0 ? catalog : undefined),
      });
      const policy: Omit<
        ReturnType<PluginRuntime["agent"]["resolveThinkingPolicy"]>,
        "defaultLevel"
      > = {
        levels: profile.levels.map(({ id, label }) => ({ id, label })),
      };
      return profile.defaultLevel ? { ...policy, defaultLevel: profile.defaultLevel } : policy;
    },
    resolveAgentTimeoutMs,
    resolveCliBackendDispatchEligibility: resolveEmbeddedCliBackendDispatchEligibility,
    resolveCliBackendDispatchEligibilityAsync: resolveEmbeddedCliBackendDispatchEligibilityAsync,
    ensureAgentWorkspace: ensurePluginAgentWorkspace,
  } satisfies Omit<
    PluginRuntime["agent"],
    "runCommandFromIngress" | "runEmbeddedAgent" | "session"
  > &
    Partial<Pick<PluginRuntime["agent"], "runCommandFromIngress" | "runEmbeddedAgent" | "session">>;

  defineCachedValue(agentRuntime, "runCommandFromIngress", () =>
    createLazyRuntimeMethod(
      loadAgentCommandRuntime,
      ({ command, identity }) =>
        async (
          opts: Parameters<PluginRuntime["agent"]["runCommandFromIngress"]>[0],
          runtime: Parameters<PluginRuntime["agent"]["runCommandFromIngress"]>[1],
        ) =>
          await command.agentCommandFromGatewayIngress(
            {
              ...identity.sanitizePublicAgentCommandIngressOpts(opts),
              senderIsOwner: opts.senderIsOwner === true,
            },
            runtime,
            undefined,
            {},
          ),
    ),
  );
  defineCachedValue(agentRuntime, "runEmbeddedAgent", () =>
    createLazyRuntimeMethod(loadEmbeddedAgentRuntime, (runtime) => runtime.runPluginEmbeddedAgent),
  );
  defineCachedValue(agentRuntime, "session", () => ({
    resolveStorePath: resolveSessionStorePathCore,
    createSessionEntry: createRuntimeSessionEntry,
    getSessionEntry,
    getSessionEntryAsync,
    getSessionEntryByIdAsync,
    listSessionEntries,
    listSessionEntriesAsync,
    withSessionEntriesAsync,
    createSessionEntryListReader: async (
      params: Parameters<RuntimeSession["createSessionEntryListReader"]>[0],
    ) =>
      (
        await import("../../config/sessions/session-entry-read-runtime.js")
      ).createSessionEntryListReader(params),
    patchSessionEntry,
    prepareSessionEntryPatch,
    upsertSessionEntry,
    runWithWorkAdmission: runWithSessionWorkAdmission,
    updateSessionStoreEntry,
  }));

  return agentRuntime as PluginRuntime["agent"];
}
