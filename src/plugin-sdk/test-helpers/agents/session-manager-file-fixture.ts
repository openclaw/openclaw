import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseSessionEntries, SessionManager } from "../../agent-sessions.js";

type OpenFileBackedSessionManagerForTestOptions = {
  sessionId?: string;
  sessionDir?: string;
  cwd?: string;
  SessionManagerClass?: typeof SessionManager;
};

function attachFilePersistence(params: {
  manager: SessionManager;
  sessionDir: string;
  target: () => string;
  initialize: boolean;
  rotateTarget?: (sessionId: string) => void;
}) {
  const manager = Object.assign(params.manager, {
    getSessionDir: () => params.sessionDir,
    getSessionFile: () => params.target(),
  });
  const writeFullFile = <T>(result: T): T => {
    const target = params.target();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const entries = manager.getPersistedEntries();
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return result;
  };
  const persistRemoval = (removed: number) => (removed > 0 ? writeFullFile(removed) : removed);
  const newSession = manager.newSession.bind(manager);
  const remove = manager.removeTrailingEntries.bind(manager);
  const removeTrailingEntriesAsync = manager.removeTrailingEntriesAsync.bind(manager);
  const prepareRewrite = manager.prepareTranscriptRewriteAsync.bind(manager);
  Object.assign(manager, {
    newSession(options?: Parameters<SessionManager["newSession"]>[0]) {
      const sessionId = options?.id ?? randomUUID();
      params.rotateTarget?.(sessionId);
      return writeFullFile(newSession({ ...options, id: sessionId }));
    },
    removeTrailingEntries: (...args: Parameters<typeof remove>) => persistRemoval(remove(...args)),
    removeTrailingEntriesAsync: async (...args: Parameters<typeof removeTrailingEntriesAsync>) =>
      persistRemoval(await removeTrailingEntriesAsync(...args)),
    prepareTranscriptRewriteAsync: async () =>
      prepareRewrite().then((rewrite) => ({
        sessionManager: rewrite.sessionManager,
        commit: async (ids: ReadonlyMap<string, string>) =>
          writeFullFile(await rewrite.commit(ids)),
      })),
    persistRecord(entry: unknown) {
      const target = params.target();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const lastByte = fs.existsSync(target) ? fs.readFileSync(target).at(-1) : undefined;
      const separator = lastByte !== undefined && lastByte !== 0x0a ? "\n" : "";
      fs.appendFileSync(target, `${separator}${JSON.stringify(entry)}\n`);
    },
  });
  return params.initialize ? writeFullFile(manager) : manager;
}

export function createFileBackedSessionManagerForTest(
  cwd: string,
  sessionDir: string = cwd,
  SessionManagerClass: typeof SessionManager = SessionManager,
) {
  const manager = SessionManagerClass.inMemory(cwd);
  return attachFilePersistence({
    manager,
    sessionDir,
    target: () => path.join(sessionDir, `${manager.getSessionId()}.jsonl`),
    initialize: true,
  });
}

export function openFileBackedSessionManagerForTest(
  target: string,
  input?: string | OpenFileBackedSessionManagerForTestOptions,
  legacyCwd?: string,
  legacySessionManagerClass: typeof SessionManager = SessionManager,
) {
  const options = typeof input === "object" ? input : undefined;
  const sessionId = options?.sessionId;
  const sessionDir = options?.sessionDir ?? (typeof input === "string" ? input : undefined);
  const cwd = options?.cwd ?? legacyCwd;
  const SessionManagerClass = options?.SessionManagerClass ?? legacySessionManagerClass;
  let activeTarget = target;
  const resolvedSessionDir = sessionDir ?? path.dirname(target);
  const exists = fs.existsSync(target);
  const manager = exists
    ? SessionManagerClass.fromEntries(parseSessionEntries(fs.readFileSync(target, "utf8")), cwd)
    : SessionManagerClass.inMemory(cwd ?? sessionDir ?? process.cwd());
  const actualId = manager.getSessionId();
  if (sessionId !== undefined && actualId !== sessionId) {
    if (exists) {
      throw new Error(`Session fixture ${target} belongs to ${actualId}, not ${sessionId}`);
    }
    manager.newSession({ id: sessionId });
  }
  return attachFilePersistence({
    manager,
    sessionDir: resolvedSessionDir,
    target: () => activeTarget,
    initialize: !exists,
    rotateTarget: (nextSessionId) =>
      (activeTarget = path.join(resolvedSessionDir, `${nextSessionId}.jsonl`)),
  });
}
