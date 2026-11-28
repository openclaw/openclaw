import { normalizeMainKey, parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import { createMemo } from "solid-js";
import { projectGateway } from "../reactive/application.ts";
import { useOptionalApplication } from "../reactive/context.ts";
import { sharedSessionsRevision } from "../reactive/shared-application-projections.ts";
import { resolveSessionDisplayName } from "../session-display.ts";
import { readSessionDefaults } from "../sessions/session-key.ts";

/** Name only exact, agent-qualified targets whose row is already visible to this connection. */
export function createCronSessionTargetLabel(): (target: string) => string {
  const app = useOptionalApplication();
  if (!app) {
    return (target) => target;
  }
  const gateway = projectGateway(app.gateway);
  const sessions = sharedSessionsRevision(app.sessions);
  const rows = createMemo(() => {
    gateway.revision();
    sessions.revision();
    const { result, resultCached } = app.sessions.state;
    return app.gateway.snapshot.phase === "connected" &&
      app.sessions.canonicalListReady &&
      !resultCached
      ? result?.sessions
      : undefined;
  });
  const byKey = createMemo(() => new Map(rows()?.map((row) => [row.key, row])));
  return (target) => {
    if (!target.startsWith("session:")) {
      return target;
    }
    const key = target.slice("session:".length).trim();
    const scoped = parseAgentSessionKeyParts(key);
    const mainKey = readSessionDefaults(app.gateway.snapshot)?.mainKey;
    // Main aliases can be redirected by the scheduler; raw global keys carry no agent scope.
    if (!scoped || scoped.rest === "main" || scoped.rest === normalizeMainKey(mainKey)) {
      return target;
    }
    const row = byKey().get(key);
    return [row?.label, row?.displayName, row?.derivedTitle].some((value) => {
      const title = value?.trim();
      return title && title !== key;
    })
      ? resolveSessionDisplayName(key, row)
      : target;
  };
}
