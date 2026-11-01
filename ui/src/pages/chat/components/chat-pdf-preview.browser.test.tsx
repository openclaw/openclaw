import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatPdfPreview } from "./chat-pdf-preview.tsx";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

it("hands the native viewer a blob URL that names the original file for toolbar downloads", async () => {
  mountSolid(() => (
    <ChatPdfPreview
      src=""
      sourceIdentity="identity-1"
      label="r75-monthly-report.pdf"
      mimeType="application/pdf"
      file={{
        path: "r75-monthly-report.pdf",
        download: async () => ({
          blob: new Blob([new TextEncoder().encode("%PDF-1.4 fixture")], {
            type: "application/pdf",
          }),
          filename: "r75-monthly-report.pdf",
        }),
      }}
    />
  ));
  await waitForSolid(() => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe.sidebar-pdf-preview__frame");
    // The native toolbar derives its suggested filename from the URL fragment;
    // a bare blob URL would suggest its UUID (issue #187543).
    expect(frame).not.toBeNull();
    expect(frame!.src.startsWith("blob:")).toBe(true);
    expect(frame!.src.endsWith("#r75-monthly-report.pdf")).toBe(true);
  });
});
