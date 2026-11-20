import type { SessionWorkspaceStatResult } from "../../../api/types.ts";
import { markdownFileLinkFromEvent } from "../../../components/markdown-file-links.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";

type Availability = SessionWorkspaceStatResult["files"][number]["status"] | "pending";
type Reference = { path: string; messageEntryId?: string };

// Matches the Gateway's sessions.files.stat request bound.
const MAX_FILES_PER_REQUEST = 64;
// Answers belong to a workspace, its permission scope and its current file listing;
// a workspace refresh replaces `directories`. Failed checks are forgotten.
const checksByWorkspace = new WeakMap<
  SessionWorkspaceState,
  {
    scope: string;
    listing: SessionWorkspaceState["directories"];
    seen: WeakSet<HTMLAnchorElement>;
    availability: Map<string, Availability>;
    waiting: Map<string, Set<HTMLAnchorElement>>;
  }
>();

/** Checks which settled file links under `root` `openSessionWorkspaceFile` would open. */
export async function checkFileLinkAvailability(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  root: ParentNode,
  scope = "",
) {
  const client = state.client;
  if (!client) {
    return;
  }
  let checks = checksByWorkspace.get(workspace);
  const listing = workspace.directories;
  if (!checks || checks.scope !== scope || checks.listing !== listing) {
    checks = { scope, listing, seen: new WeakSet(), availability: new Map(), waiting: new Map() };
    checksByWorkspace.set(workspace, checks);
  }
  const { availability, seen, waiting } = checks;
  const currentWorkspace = state.sessionWorkspaceState;
  const requests = new Map<string, { files: Reference[]; keys: string[] }>();
  for (const element of root.querySelectorAll<HTMLElement>(
    "a[data-file-path], span[data-file-path]",
  )) {
    if (element.closest('[data-chat-streaming="true"]')) {
      continue;
    }
    const previous = unavailableFileLinks.get(element);
    if (previous?.checks === checks) {
      continue;
    }
    const anchor = previous?.anchor ?? element;
    if (!(anchor instanceof HTMLAnchorElement) || (!previous && seen.has(anchor))) {
      continue;
    }
    seen.add(anchor);
    if (previous) {
      const focused = element.ownerDocument.activeElement === element;
      anchor.append(...element.childNodes);
      element.replaceWith(anchor);
      if (focused) {
        anchor.focus({ preventScroll: true });
      }
      unavailableFileLinks.delete(element);
    }
    // Resolve the reference exactly as a click on this anchor would.
    const target = markdownFileLinkFromEvent({ target: anchor } as unknown as Event);
    if (!target || target.documentRelative) {
      continue;
    }
    // Matches openFile's owner resolution for a link without a containing document.
    const sessionKey = target.sessionKey ?? workspace.sessionKey;
    const key = JSON.stringify([sessionKey, target.messageEntryId ?? null, target.path]);
    const known = availability.get(key);
    if (known === "missing") {
      unlink(anchor, checks);
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
        if (
          state.sessionWorkspaceState !== currentWorkspace ||
          checksByWorkspace.get(workspace) !== checks
        ) {
          return;
        }
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
              anchors?.forEach((anchor) => unlink(anchor, checks));
            }
          }
        }
      };
      batches.push(
        client
          .request<SessionWorkspaceStatResult>("sessions.files.stat", {
            sessionKey,
            files: batch,
            ...(agentId ? { agentId } : {}),
          })
          .then(settle, () => settle(null)),
      );
    }
  }
  await Promise.all(batches);
}

const unavailableFileLinks = new WeakMap<
  HTMLElement,
  { anchor: HTMLAnchorElement; checks: object }
>();

/** Demoted references retain their anchor for a subsequent owner-driven recheck. */
function unlink(anchor: HTMLAnchorElement, checks: object) {
  if (!anchor.isConnected) {
    return;
  }
  const text = document.createElement("span");
  text.dataset.filePath = anchor.dataset.filePath;
  text.append(...anchor.childNodes);
  const focused = anchor.ownerDocument.activeElement === anchor;
  if (focused) {
    text.tabIndex = -1;
  }
  unavailableFileLinks.set(text, { anchor, checks });
  anchor.replaceWith(text);
  if (focused) {
    text.focus({ preventScroll: true });
  }
}
