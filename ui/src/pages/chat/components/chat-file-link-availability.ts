import type { SessionWorkspaceStatResult } from "../../../api/types.ts";
import { markdownFileLinkFromAnchor } from "../../../components/markdown-file-links.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";

type Availability = SessionWorkspaceStatResult["files"][number]["status"] | "pending";
type Reference = { path: string; messageEntryId?: string };

// Matches the Gateway's sessions.files.stat request bound.
const MAX_FILES_PER_REQUEST = 64;
// Answers live as long as their workspace; failed checks are forgotten so a later render asks again.
const availabilityByWorkspace = new WeakMap<SessionWorkspaceState, Map<string, Availability>>();
const waitingByWorkspace = new WeakMap<
  SessionWorkspaceState,
  Map<string, Set<HTMLAnchorElement>>
>();

/** Replaces a link the Gateway cannot open with text that keeps its label and hover path. */
function unlink(anchor: HTMLAnchorElement) {
  if (!anchor.isConnected) {
    return;
  }
  const text = document.createElement("span");
  text.dataset.filePath = anchor.dataset.filePath;
  text.append(...anchor.childNodes);
  anchor.replaceWith(text);
}

/** Checks which settled transcript file links `openSessionWorkspaceFile` would open. */
export async function checkFileLinkAvailability(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  links: HTMLAnchorElement[],
) {
  let availability = availabilityByWorkspace.get(workspace);
  let waiting = waitingByWorkspace.get(workspace);
  if (!availability || !waiting) {
    availability = new Map();
    waiting = new Map();
    availabilityByWorkspace.set(workspace, availability);
    waitingByWorkspace.set(workspace, waiting);
  }
  const requests = new Map<string, { files: Reference[]; keys: string[] }>();
  for (const anchor of links) {
    const target = markdownFileLinkFromAnchor(anchor);
    if (!target || target.documentRelative) {
      continue;
    }
    // Matches openFile's owner resolution for a link without a containing document.
    const sessionKey = target.sessionKey ?? workspace.sessionKey;
    const key = JSON.stringify([sessionKey, target.messageEntryId ?? null, target.path]);
    const known = availability.get(key);
    if (known === "missing") {
      unlink(anchor);
    } else if (known === "pending") {
      waiting.get(key)?.add(anchor);
    } else if (known === undefined) {
      availability.set(key, "pending");
      waiting.set(key, new Set([anchor]));
      const request = requests.get(sessionKey) ?? { files: [], keys: [] };
      requests.set(sessionKey, request);
      request.files.push({
        path: target.path,
        ...(target.messageEntryId ? { messageEntryId: target.messageEntryId } : {}),
      });
      request.keys.push(key);
    }
  }
  const batches: Promise<void>[] = [];
  for (const [sessionKey, { files, keys }] of requests) {
    const agentId =
      sessionKey === workspace.sessionKey
        ? workspace.agentId
        : parseAgentSessionKey(sessionKey)?.agentId;
    for (let start = 0; start < files.length; start += MAX_FILES_PER_REQUEST) {
      const batch = files.slice(start, start + MAX_FILES_PER_REQUEST);
      const batchKeys = keys.slice(start, start + MAX_FILES_PER_REQUEST);
      const settle = (result: SessionWorkspaceStatResult | null) => {
        for (const [index, key] of batchKeys.entries()) {
          const answer = result?.files[index];
          const status = answer?.path === batch[index]?.path ? answer?.status : undefined;
          const anchors = waiting.get(key);
          waiting.delete(key);
          if (!status) {
            availability.delete(key);
          } else {
            availability.set(key, status);
            if (status === "missing") {
              anchors?.forEach(unlink);
            }
          }
        }
      };
      batches.push(
        state.sessions.statFiles(sessionKey, batch, { agentId }).then(settle, () => settle(null)),
      );
    }
  }
  await Promise.all(batches);
}
