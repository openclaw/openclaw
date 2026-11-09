import { describe, expect, it } from "vitest";
import { normalizeSessionFilesDisplay } from "../../../app/settings-contract.ts";
import type { WorkspaceCatalogFile } from "./chat-session-workspace-catalog.ts";
import { orderSessionFiles } from "./chat-session-workspace-session-files.ts";
import type { TranscriptAttachmentEntry } from "./chat-sidebar-content-types.ts";

function file(
  name: string,
  updatedAtMs: number | undefined,
  mimeType?: string,
): WorkspaceCatalogFile {
  return {
    key: `file:${name}`,
    path: `/tmp/${name}`,
    name,
    origin: "session",
    mimeType,
    updatedAtMs,
  };
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
  // The Gateway lists modified files before read files, each by path, not by time.
  const files = [
    file("zeta.txt", 3_000, "text/plain"),
    file("report-10.pdf", 1_000),
    file("report-2.pdf", 5_000),
    file("artifact.zip", undefined),
  ];
  const attachments = [image("Image", 2_000), image("alpha.png", 4_000)];

  it("keeps the Gateway order followed by transcript attachments by default", () => {
    expect(names(orderSessionFiles(files, attachments, "default"))).toEqual([
      "zeta.txt",
      "report-10.pdf",
      "report-2.pdf",
      "artifact.zip",
      "Image",
      "alpha.png",
    ]);
  });

  it("dates by modification or message time, most recent first, undated last", () => {
    expect(names(orderSessionFiles(files, attachments, "date"))).toEqual([
      "report-2.pdf",
      "alpha.png",
      "zeta.txt",
      "Image",
      "report-10.pdf",
      "artifact.zip",
    ]);
  });

  it("sorts by name across both sources with natural numbering", () => {
    expect(names(orderSessionFiles(files, attachments, "name"))).toEqual([
      "alpha.png",
      "artifact.zip",
      "Image",
      "report-2.pdf",
      "report-10.pdf",
      "zeta.txt",
    ]);
  });

  it("groups by file type, then name", () => {
    expect(names(orderSessionFiles(files, attachments, "type"))).toEqual([
      "artifact.zip",
      "alpha.png",
      "Image",
      "report-2.pdf",
      "report-10.pdf",
      "zeta.txt",
    ]);
  });

  it("never mutates the source arrays", () => {
    const sourceFiles = [...files];
    orderSessionFiles(sourceFiles, attachments, "date");
    expect(sourceFiles).toEqual(files);
  });
});

describe("normalizeSessionFilesDisplay", () => {
  it("drops the default display and repairs unknown choices", () => {
    expect(normalizeSessionFilesDisplay(undefined)).toBeUndefined();
    expect(normalizeSessionFilesDisplay({ view: "list", sort: "default" })).toBeUndefined();
    expect(normalizeSessionFilesDisplay({ view: "grid" })).toEqual({
      view: "grid",
      sort: "default",
    });
    expect(normalizeSessionFilesDisplay({ view: "mosaic", sort: "name" })).toEqual({
      view: "list",
      sort: "name",
    });
    // Retired choices from an earlier build fall back rather than crash.
    expect(normalizeSessionFilesDisplay({ view: "grid", sort: "newest" })).toEqual({
      view: "grid",
      sort: "default",
    });
  });
});
