import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { withManagedImageSessionRead } from "../../gateway/managed-image-session-read.js";
import { readSessionMessagesWithSourceAsync } from "../../gateway/session-transcript-readers.js";
import { iterateSessionTranscriptSourcePages } from "../../gateway/session-transcript-source-pages.js";
import { maybeLocalPathFromSource } from "../../media/inbound-media-path.js";
import {
  parseInboundMediaUri,
  normalizeMediaReferenceSource,
} from "../../media/inbound-media-uri.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import { getMediaDir } from "../../media/store.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
} from "./gateway-caller-context.js";

function sourcePath(reference: string): string | undefined {
  const source = normalizeMediaReferenceSource(reference);
  const inbound = parseInboundMediaUri(source);
  if (inbound) {
    return path.resolve(getMediaDir(), "inbound", inbound.id);
  }
  const local = maybeLocalPathFromSource(source);
  return local ? path.resolve(local) : undefined;
}

/** Source disclosure is independent of destination-machine ownership. */
export async function withGatewayToolAttachmentRead<T>(
  paths: readonly string[],
  consume: (assertCurrent: () => void) => Promise<T>,
  sourceTool: "browser" | "file_write" = "browser",
): Promise<T> {
  const caller = getGatewayToolCallerIdentity();
  const selected = resolveGatewayToolOperatorSelection();
  const authority = selected ? selected.operatorAuthority : caller?.operatorAuthority;
  const captured = captureGatewayToolCallerAssertion("environments.session.invoke");
  if (!caller || !authority || !captured || !caller.gatewayContextResolver) {
    throw new Error("Upload source requires current admitted caller authority");
  }
  const assertCaller = () => {
    captured();
    authority.assertCurrent();
    caller.assertToolAllowed?.(sourceTool);
  };
  assertCaller();
  if (authority.scopes.includes("operator.admin")) {
    return await consume(assertCaller);
  }
  const context = caller.gatewayContextResolver();
  assertCaller();
  if (!context) {
    throw new Error("Upload source Gateway context is unavailable");
  }
  const needed = new Set(paths.map((file) => sourcePath(file)));
  if (needed.has(undefined)) {
    throw new Error("Unsupported upload source reference");
  }
  const resolved = await withManagedImageSessionRead(
    {
      cfg: context.getRuntimeConfig(),
      sessionKey: caller.sessionKey,
      agentId: caller.agentId,
      stateDir: resolveStateDir(),
      assertCurrent: assertCaller,
    },
    async (scope, assertCurrent) => {
      const pending = new Set(needed);
      for await (const page of iterateSessionTranscriptSourcePages(
        readSessionMessagesWithSourceAsync,
        scope,
      )) {
        assertCurrent();
        for (const message of page.messages) {
          if (!message || typeof message !== "object") {
            continue;
          }
          for (const fact of readPersistedMediaFacts(message) ?? []) {
            const reference = fact.path ?? fact.url;
            if (reference) {
              pending.delete(sourcePath(reference));
            }
          }
          const tool = "toolName" in message ? message.toolName : undefined;
          if (tool === "file_fetch" || tool === "dir_fetch") {
            const details =
              "details" in message && message.details && typeof message.details === "object"
                ? message.details
                : undefined;
            const media =
              details && "media" in details && details.media && typeof details.media === "object"
                ? details.media
                : undefined;
            const urls = media && "mediaUrls" in media ? media.mediaUrls : undefined;
            if (Array.isArray(urls)) {
              for (const url of urls) {
                if (typeof url === "string") {
                  pending.delete(sourcePath(url));
                }
              }
            }
          }
        }
        if (!pending.size) {
          break;
        }
      }
      if (pending.size) {
        throw new Error(
          "Upload source is not an accepted attachment in this authorized conversation",
        );
      }
      assertCurrent();
      return { value: await consume(assertCurrent) };
    },
  );
  if (!resolved) {
    throw new Error("Upload source conversation is unavailable");
  }
  return resolved.value;
}
