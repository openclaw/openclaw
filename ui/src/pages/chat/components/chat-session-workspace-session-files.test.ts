import { describe, expect, it } from "vitest";
import { normalizeSessionFilesDisplay } from "../../../app/settings-contract.ts";
import type { WorkspaceCatalogFile } from "./chat-session-workspace-catalog.ts";
import { orderSessionFiles } from "./chat-session-workspace-session-files.ts";
import type { TranscriptAttachmentEntry } from "./chat-sidebar-content-types.ts";

function file(name: string, updatedAtMs?: number): WorkspaceCatalogFile {
  return { key: `file:${name}`, path: `/tmp/${name}`, name, origin: "session", updatedAtMs };
}

function image(label: string, timestamp?: number): TranscriptAttachmentEntry {
  return {
    kind: "image",
    key: `image:${label}`,
    label,
    timestamp,
    image: { url: "data:image/png;base64,AA==" },
    options: {},
    onOpenSidebar: () => {},
  };
}

function names(entries: ReturnType<typeof orderSessionFiles>) {
  return entries.map((entry) => (entry.kind === "file" ? entry.file.name : entry.entry.label));
}

describe("orderSessionFiles", () => {
  // The Gateway lists modified files before read files by path, never by time.
  const files = [
    file("zeta.txt", 3_000),
    file("report-10.pdf", 1_000),
    file("report-2.pdf", 5_000),
  ];
  const attachments = [image("Image", 2_000), image("alpha.png", 4_000)];

  it("dates by modification or message time across sources, undated last", () => {
    expect(names(orderSessionFiles([...files, file("artifact.zip")], attachments, "date"))).toEqual(
      ["report-2.pdf", "alpha.png", "zeta.txt", "Image", "report-10.pdf", "artifact.zip"],
    );
  });

  it("sorts by name with natural numbering and leaves the inputs unchanged", () => {
    const sourceFiles = [...files];
    expect(names(orderSessionFiles(sourceFiles, attachments, "name"))).toEqual([
      "alpha.png",
      "Image",
      "report-2.pdf",
      "report-10.pdf",
      "zeta.txt",
    ]);
    expect(sourceFiles).toEqual(files);
  });
});

describe("normalizeSessionFilesDisplay", () => {
  it("drops the default display and repairs unknown or retired choices", () => {
    expect(normalizeSessionFilesDisplay(undefined)).toBeUndefined();
    expect(normalizeSessionFilesDisplay({ view: "list", sort: "default" })).toBeUndefined();
    expect(normalizeSessionFilesDisplay({ view: "grid", sort: "newest" })).toEqual({
      view: "grid",
      sort: "default",
    });
  });
});
