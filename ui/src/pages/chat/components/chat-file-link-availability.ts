import type { SessionWorkspaceStatResult } from "../../../api/types.ts";
import {
  MARKDOWN_FILE_LINK_UNAVAILABLE_ATTR,
  markdownFileLinkFromAnchor,
} from "../../../components/markdown-file-links.ts";

export type FileLinkStatRequest = {
  sessionKey?: string;
  files: { path: string; messageEntryId?: string }[];
};

/** Resolves to null when the Gateway cannot answer, such as after a disconnect. */
export type FileLinkStat = (
  request: FileLinkStatRequest,
) => Promise<SessionWorkspaceStatResult | null>;

type Availability = SessionWorkspaceStatResult["files"][number]["status"] | "pending";

const FILE_LINK_SELECTOR = "a[data-file-path]";
const STREAMING_SELECTOR = '[data-chat-streaming="true"]';
// Matches the Gateway's sessions.files.stat request bound.
const MAX_FILES_PER_REQUEST = 64;

function markUnavailable(anchor: HTMLAnchorElement) {
  anchor.setAttribute(MARKDOWN_FILE_LINK_UNAVAILABLE_ATTR, "");
  anchor.removeAttribute("role");
  anchor.removeAttribute("tabindex");
}

/**
 * Demotes transcript file links that the Gateway reports it cannot open to plain text.
 *
 * Links are checked once their message stops streaming, so a path written before the
 * agent creates the file is not judged early. Results are kept for the lifetime of the
 * observer; failed checks are forgotten so a later render can ask again.
 */
export function observeFileLinkAvailability(
  root: HTMLElement,
  stat: FileLinkStat,
  /** Identifies the session that owns links without their own session key. */
  defaultSessionKey: () => string | undefined,
): () => void {
  const availability = new Map<string, Availability>();
  const waiting = new Map<string, Set<HTMLAnchorElement>>();
  const queued = new Set<Element>([root]);
  let scheduled = false;
  let disposed = false;

  const collect = (scope: Element, anchors: Set<HTMLAnchorElement>) => {
    if (scope instanceof HTMLAnchorElement && scope.matches(FILE_LINK_SELECTOR)) {
      anchors.add(scope);
    }
    for (const anchor of scope.querySelectorAll<HTMLAnchorElement>(FILE_LINK_SELECTOR)) {
      anchors.add(anchor);
    }
  };

  const scan = () => {
    scheduled = false;
    if (disposed) {
      return;
    }
    const found = new Set<HTMLAnchorElement>();
    for (const scope of queued) {
      if (scope.isConnected) {
        collect(scope, found);
      }
    }
    queued.clear();
    const requests = new Map<string, FileLinkStatRequest & { keys: string[] }>();
    for (const anchor of found) {
      if (
        anchor.hasAttribute(MARKDOWN_FILE_LINK_UNAVAILABLE_ATTR) ||
        anchor.dataset.fileDocumentRelative === "true" ||
        anchor.closest(STREAMING_SELECTOR)
      ) {
        continue;
      }
      const target = markdownFileLinkFromAnchor(anchor);
      if (!target) {
        continue;
      }
      const sessionKey = target.sessionKey ?? defaultSessionKey() ?? "";
      const key = JSON.stringify([sessionKey, target.messageEntryId ?? null, target.path]);
      const known = availability.get(key);
      if (known === "missing") {
        markUnavailable(anchor);
        continue;
      }
      if (known === "pending") {
        waiting.get(key)?.add(anchor);
        continue;
      }
      if (known !== undefined) {
        continue;
      }
      availability.set(key, "pending");
      waiting.set(key, new Set([anchor]));
      let request = requests.get(sessionKey);
      if (!request) {
        request = {
          ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
          files: [],
          keys: [],
        };
        requests.set(sessionKey, request);
      }
      request.files.push({
        path: target.path,
        ...(target.messageEntryId ? { messageEntryId: target.messageEntryId } : {}),
      });
      request.keys.push(key);
    }
    for (const { keys, files, ...owner } of requests.values()) {
      for (let start = 0; start < files.length; start += MAX_FILES_PER_REQUEST) {
        const batch = files.slice(start, start + MAX_FILES_PER_REQUEST);
        const batchKeys = keys.slice(start, start + MAX_FILES_PER_REQUEST);
        const settle = (result: SessionWorkspaceStatResult | null) => {
          if (disposed) {
            return;
          }
          for (const [index, key] of batchKeys.entries()) {
            const answer = result?.files[index];
            const status = answer?.path === batch[index]?.path ? answer?.status : undefined;
            const anchors = waiting.get(key);
            waiting.delete(key);
            if (!status) {
              availability.delete(key);
              continue;
            }
            availability.set(key, status);
            if (status === "missing") {
              for (const anchor of anchors ?? []) {
                if (anchor.isConnected) {
                  markUnavailable(anchor);
                }
              }
            }
          }
        };
        stat({ ...owner, files: batch }).then(settle, () => settle(null));
      }
    }
  };

  const schedule = () => {
    if (!scheduled && !disposed) {
      scheduled = true;
      queueMicrotask(scan);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof Element) {
          queued.add(record.target);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          queued.add(node);
        }
      }
    }
    if (queued.size > 0) {
      schedule();
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-chat-streaming", "data-file-path"],
  });
  schedule();
  return () => {
    disposed = true;
    observer.disconnect();
  };
}
