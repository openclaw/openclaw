import type { SidebarContent } from "./chat-sidebar-content-types.ts";

type FileSidebarContent = Extract<SidebarContent, { kind: "file" }>;

type RetainedFileDraft = {
  content: string;
  expectedHash: string;
};

const retainedFileDrafts = new Map<string, RetainedFileDraft>();

function retainedFileDraftKey(content: FileSidebarContent): string {
  return content.draftKey ?? `${content.root ?? ""}\u0000${content.path}`;
}

export function readFileDraft(content: FileSidebarContent): RetainedFileDraft | undefined {
  return retainedFileDrafts.get(retainedFileDraftKey(content));
}

export function setFileDraft(content: FileSidebarContent, draft: RetainedFileDraft | null) {
  const key = retainedFileDraftKey(content);
  retainedFileDrafts.delete(key);
  if (!draft) {
    return;
  }
  retainedFileDrafts.set(key, draft);
}
