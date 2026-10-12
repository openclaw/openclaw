import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSqliteSessionKey } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "./runtime/types.js";

/** Worker reads and process-local actor preparation for plugin ownership decisions. */
export function createPluginSessionOwnershipReads({
  runtime,
  currentSessionConfig,
  assertRuntimeOwnerCurrent,
}: {
  runtime: PluginRuntime;
  currentSessionConfig: () => OpenClawConfig;
  assertRuntimeOwnerCurrent: () => void;
}) {
  const readOwnershipEntry = async (
    params: Parameters<PluginRuntime["agent"]["session"]["getSessionEntryAsync"]>[0],
  ) => {
    const source = captureIncognitoSessionSource(params);
    if (!source) {
      const entry = await runtime.agent.session.getSessionEntryAsync(params);
      assertRuntimeOwnerCurrent();
      return entry;
    }
    if ("kind" in source) {
      return undefined;
    }
    const key = resolveSqliteSessionKey(params.sessionKey, source.actor.agentId);
    const sharing = source.actor.sessions.readSharing(key)?.entry;
    if (!sharing) {
      return undefined;
    }
    const policy = source.actor.sessions.readCapability(key);
    return {
      ...sharing,
      pluginOwnerId: policy?.pluginOwnerId,
      agentHarnessId: policy?.agentHarnessId,
      agentRuntimeOverride: policy?.agentRuntimeOverride,
    };
  };
  const listOwnershipEntries = async (params: { agentId?: string; storePath?: string }) => {
    const ambient = params.storePath ? undefined : captureIncognitoSessionSource();
    const source = captureIncognitoSessionSource(
      ambient
        ? { ...params, storePath: "kind" in ambient ? ambient.path : ambient.actor.path }
        : params,
    );
    if (!source) {
      const selectedAgentId = params.agentId ?? resolveDefaultAgentId(currentSessionConfig());
      const entries = await runtime.agent.session.listSessionEntriesAsync({
        ...params,
        agentId: selectedAgentId,
      });
      assertRuntimeOwnerCurrent();
      return entries;
    }
    if ("kind" in source) {
      return [];
    }
    const entries = await Promise.all(
      source.actor.sessions.deadlines().map(async ({ sessionKey }) => {
        const entry = await readOwnershipEntry({
          ...params,
          sessionKey,
          storePath: source.actor.path,
        });
        return entry ? { sessionKey, entry } : undefined;
      }),
    );
    return entries.filter((entry) => entry !== undefined);
  };
  const withPreparedSessionOwnership = async <T>(
    params: { agentId?: string; storePath?: string; sessionKey?: string; sessionFile?: string },
    run: () => Promise<T>,
  ): Promise<T> => {
    const marker = params.sessionFile && parseSqliteSessionFileMarker(params.sessionFile);
    const target = marker ? { ...params, ...marker } : params;
    const ambient =
      !target.sessionKey && !target.storePath ? captureIncognitoSessionSource() : undefined;
    const source = captureIncognitoSessionSource(
      ambient
        ? { ...target, storePath: "kind" in ambient ? ambient.path : ambient.actor.path }
        : target,
    );
    if (!source || "kind" in source) {
      return await run();
    }
    return source.actor.sessions.withSharedState(async () => {
      const assertCurrent = () => {
        assertRuntimeOwnerCurrent();
        source.admissionSignal?.throwIfAborted();
        source.actor.assertReadable();
      };
      // Publish exact ownership facts once; final guards consume their live postimages.
      await source.actor.sessions.list(
        { assertCurrent },
        { projection: "list" },
        source.admissionSignal,
      );
      assertCurrent();
      return await run();
    });
  };
  return { readOwnershipEntry, listOwnershipEntries, withPreparedSessionOwnership };
}
