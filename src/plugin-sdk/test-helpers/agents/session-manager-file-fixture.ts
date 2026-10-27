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

function attachFilePersistence(
  manager: SessionManager,
  sessionDir: string,
  initialTarget?: string,
  initialize = true,
) {
  let activeTarget = initialTarget;
  const sessionFile = (id = manager.getSessionId()) => path.join(sessionDir, `${id}.jsonl`);
  const getTarget = () => activeTarget ?? sessionFile();
  const write = <T>(result: T): T => {
    const target = getTarget();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const entries = manager.getPersistedEntries();
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return result;
  };
  const persistRemoval = (removed: number) => (removed > 0 ? write(removed) : removed);
  const newSession = manager.newSession.bind(manager);
  const remove = manager.removeTrailingEntries.bind(manager);
  const removeTrailingEntriesAsync = manager.removeTrailingEntriesAsync.bind(manager);
  const prepareRewrite = manager.prepareTranscriptRewriteAsync.bind(manager);
  const fileManager = Object.assign(manager, {
    getSessionDir: () => sessionDir,
    getSessionFile: getTarget,
    newSession(options?: Parameters<SessionManager["newSession"]>[0]) {
      const sessionId = options?.id ?? randomUUID();
      if (activeTarget !== undefined) {
        activeTarget = sessionFile(sessionId);
      }
      return write(newSession({ ...options, id: sessionId }));
    },
    removeTrailingEntries: (...args: Parameters<typeof remove>) => persistRemoval(remove(...args)),
    removeTrailingEntriesAsync: async (...args: Parameters<typeof removeTrailingEntriesAsync>) =>
      persistRemoval(await removeTrailingEntriesAsync(...args)),
    prepareTranscriptRewriteAsync: async () =>
      prepareRewrite().then((rewrite) => ({
        sessionManager: rewrite.sessionManager,
        commit: async (ids: ReadonlyMap<string, string>) => write(await rewrite.commit(ids)),
      })),
    persistRecord(entry: unknown) {
      const target = getTarget();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const lastByte = fs.existsSync(target) ? fs.readFileSync(target).at(-1) : undefined;
      const separator = lastByte !== undefined && lastByte !== 0x0a ? "\n" : "";
      fs.appendFileSync(target, `${separator}${JSON.stringify(entry)}\n`);
    },
  });
  return initialize ? write(fileManager) : fileManager;
}

export function createFileBackedSessionManagerForTest(
  cwd: string,
  sessionDir: string = cwd,
  SessionManagerClass: typeof SessionManager = SessionManager,
) {
  return attachFilePersistence(SessionManagerClass.inMemory(cwd), sessionDir);
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
  return attachFilePersistence(manager, sessionDir ?? path.dirname(target), target, !exists);
}
