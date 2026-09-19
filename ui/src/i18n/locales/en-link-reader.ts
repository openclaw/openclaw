import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enLinkReader = {
  linkReader: {
    cachedPreview: "Cached details",
    previewAriaLabel: "Preview: {title}",
    newTab: "New reader tab",
    openUrl: "Open URL",
    closeTab: "Close {title}",
    tabLimit: "Ten reader tabs are already open. Close a tab or open this item externally.",
    invalidUrl: "Enter a URL supported by an enabled link reader.",
    image: "Image",
    openImage: "Open full-size image",
    openImageTitle: "Open full-size image: {title}",
    imageUnavailable: "Image unavailable: {title}",
    commentPermalink: "Link to this comment",
    reviewContext: "Show diff context",
    replyContext: "View parent comment",
    back: "Back",
    forward: "Forward",
    refresh: "Refresh item",
    close: "Close link reader",
    resize: "Resize link reader",
    openExternal: "Open on {provider}",
    openOriginal: "Open original",
    byAuthor: "by {author}",
    description: "Description",
    noDescription: "No description provided.",
    comments: "Comments",
    noComments: "No comments yet.",
    files: "Changed files",
    noFiles: "No changed files.",
    renamedFrom: "Renamed from {filename}",
    diffLabel: "Diff for {filename}",
    partial: "This view is incomplete. Open the original for the full item.",
    bodyTruncated: "This text was shortened.",
    commentsTruncated:
      "Some comments could not be shown. Open the original for the full conversation.",
    filesTruncated: "Some files could not be shown. Open the original for the full changes.",
    patchTruncated: "This diff was shortened. Open the original for the full patch.",
    patchUnavailable:
      "No text diff available in this view. Open the original to inspect this file.",
    unavailableTitle: "Item unavailable",
    unavailable:
      "This item may be private or deleted, or its service may be unavailable or rate-limiting requests. Try again later or open the original.",
    disconnected: "This reader is unavailable on this connection. Reconnect or open the original.",
    retry: "Retry",
  },
} satisfies TranslationMap;

export const registerLinkReaderEnglish = Object.assign(
  () => Object.assign(en.linkReader, enLinkReader.linkReader),
  { catalog: enLinkReader },
);
