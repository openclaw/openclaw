import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

export type SessionMcpStoreSource = {
  agentId: string;
  databaseIdentity: string;
  databaseBirthtime?: string;
};

type Target = { sessionId: string; sessionKey?: string; agentId?: string };
type StoreOwner = SessionMcpStoreSource & { sessionId: string; sessionKey: string };
const admissions = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionMcpStoreAdmissions"),
  () => new WeakMap<object, StoreOwner>(),
);

export function bindSessionMcpStoreOwner(admission: object, owner: StoreOwner | undefined): void {
  if (owner) {
    admissions.set(admission, owner);
  } else {
    admissions.delete(admission);
  }
}

export function inheritSessionMcpStoreOwner(source: object | undefined, target: object): void {
  bindSessionMcpStoreOwner(target, source && admissions.get(source));
}

export function sessionMcpStoreSourceKey(source: SessionMcpStoreSource): string {
  return JSON.stringify([
    source.agentId,
    source.databaseIdentity,
    source.databaseBirthtime ?? null,
  ]);
}

export function readSessionMcpStoreOwner(admission: object | undefined, target: Target) {
  const owner = admission && admissions.get(admission);
  return owner &&
    owner.sessionId === target.sessionId &&
    owner.sessionKey === target.sessionKey &&
    (!target.agentId || target.agentId === owner.agentId)
    ? sessionMcpStoreSourceKey(owner)
    : undefined;
}
