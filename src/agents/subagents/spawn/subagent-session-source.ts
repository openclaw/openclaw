import path from "node:path";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../../config/sessions/session-incognito-binding.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { captureOpenClawAgentDatabaseExecution } from "../../../state/openclaw-agent-execution.js";

/** Explicit binding selects existing child/requester actors; ordinary calls keep their native owner. */
export async function withSubagentSessionSource<T>(
  input: {
    agentId: string;
    sessionKey: string;
    storePath?: string;
    assertCurrent?: () => void;
  },
  consume: (source: ReturnType<typeof captureIncognitoSessionSource>) => Promise<T>,
): Promise<T> {
  const target = { ...input };
  const source = isIncognitoSessionKey(target.sessionKey)
    ? captureIncognitoSessionSource()
    : undefined;
  if (!source) {
    return consume(undefined);
  }
  const assertCurrent = () => {
    target.assertCurrent?.();
    source.admissionSignal?.throwIfAborted();
    if ("kind" in source) {
      source.assertCurrent();
    } else {
      source.actor.assertReadable();
    }
  };
  const read = async () => {
    assertCurrent();
    const selectedSource = captureIncognitoSessionSource(target);
    const result = await consume(selectedSource);
    assertCurrent();
    if (selectedSource && "kind" in selectedSource) {
      selectedSource.assertCurrent();
    }
    return result;
  };
  if (("kind" in source ? source.agentId : source.actor.agentId) === target.agentId) {
    const result =
      "kind" in source
        ? await read()
        : await withIncognitoSessionActor(source.actor, read, source.admissionSignal);
    assertCurrent();
    return result;
  }
  const env =
    "kind" in source
      ? source.env
      : { OPENCLAW_STATE_DIR: path.resolve(source.actor.path, "../../../..") };
  const selected = captureOpenClawAgentDatabaseExecution
    .listIncognito(env)
    .find((entry) => entry.agentId === target.agentId);
  if (!selected) {
    return withIncognitoSessionBinding(
      { kind: "absent", agentId: target.agentId, env, authority: { assertCurrent } },
      read,
    );
  }
  const actor = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: target.agentId,
    env,
    authority: { assertCurrent },
    existingOnly: true,
    signal: source.admissionSignal,
  });
  if (!actor) {
    throw new Error("Subagent session actor ended during source selection");
  }
  let result: T;
  try {
    selected.assertCurrent();
    if (actor.identity.incarnation !== selected.identity.incarnation) {
      throw new Error("Subagent session actor changed during source selection");
    }
    result = await withIncognitoSessionActor(actor, read, source.admissionSignal);
  } finally {
    await actor.release();
  }
  assertCurrent();
  selected.assertCurrent();
  return result;
}
