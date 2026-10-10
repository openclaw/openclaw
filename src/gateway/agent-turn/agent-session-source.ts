import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  captureSessionEntryMetadataRead,
  captureSessionEntrySourceAssertion,
} from "../../config/sessions/session-entry-source-authority.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../../sessions/session-id-resolution.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { loadSessionEntry } from "../session-utils.js";

/** Retain the ingress selection through preparation, acceptance and execution settlement. */
export function captureAgentSessionSource() {
  const binding = captureIncognitoSessionSource();
  let active = true;
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const settled =
    binding && !("kind" in binding)
      ? binding.actor.sessions.withSharedState(() => completed)
      : undefined;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Agent session source is no longer retained");
    }
    if (binding) {
      binding.admissionSignal?.throwIfAborted();
      if ("kind" in binding) {
        binding.assertCurrent();
      } else {
        binding.actor.assertReadable();
      }
    }
  };
  const run = <T>(operation: () => T): T => {
    assertCurrent();
    return binding
      ? withIncognitoSessionBinding(
          "kind" in binding
            ? { ...binding, authority: { assertCurrent: binding.assertCurrent } }
            : binding,
          operation,
        )
      : operation();
  };
  return {
    bound: binding !== undefined,
    assertCurrent,
    run,
    readCurrent(sessionKey: string, agentId?: string) {
      return run(() => {
        const metadata = captureSessionEntryMetadataRead({ sessionKey, agentId });
        return metadata
          ? metadata.readCurrent()
          : loadSessionEntry(sessionKey, { agentId, clone: false, projection: "list" }).entry;
      });
    },
    async resolveExistingSessionId(sessionId: string, agentId?: string) {
      return run(async () => {
        if (!binding) throw new Error("Session ID resolution requires its selected actor");
        const owner = "kind" in binding ? binding : binding.actor;
        if (agentId && agentId !== owner.agentId)
          throw new Error("Session target belongs to another incognito actor");
        if ("kind" in binding)
          return { agentId: owner.agentId, storePath: owner.path, sessionKey: undefined };
        const listed = await binding.actor.sessions.list(
          { assertCurrent },
          { projection: "list" },
          binding.admissionSignal,
        );
        assertCurrent();
        const matches = listed.entries
          .filter(({ entry }) => entry.sessionId === sessionId)
          .map(({ sessionKey, entry }): [string, SessionEntry] => [sessionKey, entry]);
        const selection = resolveSessionIdMatchSelection(matches, sessionId);
        return {
          agentId: owner.agentId,
          storePath: owner.path,
          sessionKey: selection.kind === "selected" ? selection.sessionKey : undefined,
        };
      });
    },
    async read(params: { cfg: OpenClawConfig; key: string; agentId?: string }) {
      const result = await run(() =>
        binding
          ? loadGatewaySessionEntryReadOnlyInWorker({ ...params, assertActive: assertCurrent })
          : loadSessionEntry(params.key, { agentId: params.agentId, clone: false }),
      );
      assertCurrent();
      return result;
    },
    async release() {
      if (!active) return;
      active = false;
      finish?.();
      await settled;
    },
  };
}
export type AgentSessionSource = ReturnType<typeof captureAgentSessionSource>;

/** Retain a related source and the exact fields consumed by the request. */
export async function prepareAgentRelatedSessionSource(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  fields: readonly (keyof SessionEntry)[];
}) {
  const { cfg, sessionKey, fields } = params;
  const ambient = isIncognitoSessionKey(sessionKey) ? captureIncognitoSessionSource() : undefined;
  let binding = ambient;
  let retained: IncognitoAgentDatabaseExecution | undefined;
  let handedOff = false;
  let active = true;
  let finishShared: (() => void) | undefined;
  let sharedState: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;
  const release = () => {
    releasePromise ??= (async () => {
      active = false;
      finishShared?.();
      try {
        await sharedState;
      } finally {
        await retained?.release();
      }
    })();
    return releasePromise;
  };
  const assertAmbient = () => {
    if (!active) throw new Error("Related session source is no longer retained");
    if (!ambient) return;
    ambient.admissionSignal?.throwIfAborted();
    if ("kind" in ambient) ambient.assertCurrent();
    else ambient.actor.assertReadable();
  };
  try {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    if (ambient && agentId !== ("kind" in ambient ? ambient.agentId : ambient.actor.agentId)) {
      const env =
        "kind" in ambient
          ? ambient.env
          : { OPENCLAW_STATE_DIR: path.resolve(ambient.actor.path, "../../../..") };
      const selected = captureOpenClawAgentDatabaseExecution
        .listIncognito(env)
        .find((actor) => actor.agentId === agentId);
      if (!selected) return undefined;
      retained = await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId,
        env,
        existingOnly: true,
        authority: { assertCurrent: assertAmbient },
        signal: ambient.admissionSignal,
      });
      assertAmbient();
      selected.assertCurrent();
      if (!retained || retained.identity.incarnation !== selected.identity.incarnation)
        throw new Error("Parent actor changed during group inheritance");
      binding = { actor: retained, admissionSignal: ambient.admissionSignal };
    }
    if (binding && !("kind" in binding)) {
      const completed = new Promise<void>((resolve) => {
        finishShared = resolve;
      });
      sharedState = binding.actor.sessions.withSharedState(() => completed);
    }
    const run = <T>(operation: () => T) =>
      binding
        ? withIncognitoSessionBinding(
            "kind" in binding
              ? { ...binding, authority: { assertCurrent: binding.assertCurrent } }
              : binding,
            operation,
          )
        : operation();
    const loaded = await run(() =>
      loadGatewaySessionEntryReadOnlyInWorker({
        cfg,
        key: sessionKey,
        agentId,
        assertActive: assertAmbient,
      }),
    );
    const metadata = run(() =>
      captureSessionEntryMetadataRead({
        sessionKey: loaded.canonicalKey,
        agentId: loaded.agentId,
        storePath: loaded.storePath,
      }),
    );
    const select = (entry: Partial<SessionEntry> | undefined) =>
      entry && Object.fromEntries(fields.map((field) => [field, entry[field]]));
    const expected = select(loaded.entry);
    const assertCurrent = () => {
      assertAmbient();
      const entry = metadata
        ? metadata.readCurrent()
        : loadSessionEntry(loaded.canonicalKey, { agentId: loaded.agentId, clone: false }).entry;
      if (!isDeepStrictEqual(select(entry), expected))
        throw new Error("Related session changed while preparing the request");
    };
    assertCurrent();
    const refuse = (): never => {
      throw new Error("Related session changed while preparing the request");
    };
    // One actor can validate its related row inside the destination transaction.
    // A different actor keeps its own exact published facts and incarnation;
    // its database is never attached to the destination's transaction.
    const source: SessionSourceAssertion =
      binding && !retained
        ? run(() =>
            captureSessionEntrySourceAssertion({
              scope: {
                agentId: loaded.agentId,
                sessionKey: loaded.canonicalKey,
                storePath: loaded.storePath,
              },
              expected: loaded.entry,
              fields,
              assertCurrent: assertAmbient,
              refuse,
            }),
          )
        : Object.assign(assertCurrent, {
            async prepareSessionSource() {
              assertCurrent();
              return { assertCurrent, checks: [] };
            },
          });
    handedOff = true;
    return {
      entry: loaded.entry,
      source,
      release,
    };
  } finally {
    if (!handedOff) await release();
  }
}
