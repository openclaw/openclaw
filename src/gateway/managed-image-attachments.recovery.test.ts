import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { resolveOutboundAttachmentFromUrl } from "../media/outbound-attachment.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createManagedOutgoingMediaBlocks } from "./managed-image-attachments.js";
import { listManagedImageRecordEntries } from "./managed-image-record-store.js";

it("classifies a staged unsupported archive while preserving its ZIP sibling and saved bytes", () =>
  withOpenClawTestState(
    { label: "managed-file-recovery" },
    async ({ root, stateDir, workspaceDir }) => {
      const gzip = gzipSync("Useful generated report\n");
      // ZIP_STORED archive containing report.txt with the same synthetic report.
      const zip = Buffer.from(
        "UEsDBBQAAAAAAAAAIVzYT4/WGAAAABgAAAAKAAAAcmVwb3J0LnR4dFVzZWZ1bCBnZW5lcmF0ZWQgcmVwb3J0ClBLAQIUAxQAAAAAAAAAIVzYT4/WGAAAABgAAAAKAAAAAAAAAAAAAACAAQAAAAByZXBvcnQudHh0UEsFBgAAAAABAAEAOAAAAEAAAAAAAA==",
        "base64",
      );
      const files = [
        { name: "report.txt.gz", mimeType: "application/gzip", body: gzip },
        { name: "report.zip", mimeType: "application/zip", body: zip },
      ];
      const items = [];
      for (const file of files) {
        const source = path.join(workspaceDir, file.name);
        await fs.writeFile(source, file.body);
        const staged = await resolveOutboundAttachmentFromUrl(source, 1024, {
          localRoots: [workspaceDir],
        });
        expect(staged.contentType).toBe(file.mimeType);
        expect(await fs.readFile(staged.path)).toEqual(file.body);
        items.push({
          url: staged.path,
          filename: file.name,
          mimeType: staged.contentType,
          trustedLocal: true,
        });
      }
      const errors: Error[] = [];
      const blocks = await createManagedOutgoingMediaBlocks({
        sessionKey: "agent:main:main",
        items,
        stateDir,
        localRoots: [path.join(stateDir, "media", "outbound")],
        continueOnPrepareError: true,
        onPrepareError: (error) => errors.push(error),
      });
      expect(blocks[1]).toMatchObject({
        type: "attachment",
        attachment: { mimeType: "application/zip", label: "report.zip" },
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).not.toContain(root);
      const records = await listManagedImageRecordEntries({ stateDir });
      expect(records).toHaveLength(1);
      for (const file of files) {
        expect(await fs.readFile(path.join(workspaceDir, file.name))).toEqual(file.body);
      }
      const { original } = records[0]!.record;
      const zipPath = path.join(original.mediaRoot, original.mediaSubdir, original.mediaId);
      expect(await fs.readdir(path.dirname(zipPath))).toEqual([path.basename(zipPath)]);
      expect(await fs.readFile(zipPath)).toEqual(zip);
      expect(blocks[0]).toMatchObject({
        type: "attachment_error",
        attachment: { code: "unsupported-format", label: "report.txt.gz" },
      });
    },
  ));

it.each(["path denied", "storage unavailable"])(
  "does not classify a gzip file as unsupported when %s prevents ingestion",
  (failure) =>
    withOpenClawTestState({ label: "managed-file-read-failure" }, async (state) => {
      const { stateDir, workspaceDir } = state;
      const source = path.join(workspaceDir, "report.txt.gz");
      const bytes = gzipSync("Useful generated report\n");
      await fs.writeFile(source, bytes);
      const allowed = state.statePath("allowed");
      await fs.mkdir(allowed);
      if (failure === "storage unavailable") {
        // A real non-directory destination prevents managed storage from preparing.
        await state.writeText("media/outgoing", "occupied");
      }
      const errors: Error[] = [];
      const blocks = await createManagedOutgoingMediaBlocks({
        sessionKey: "agent:main:main",
        stateDir,
        items: [
          {
            url: source,
            filename: "report.txt.gz",
            mimeType: "application/gzip",
            trustedLocal: true,
          },
        ],
        localRoots: [failure === "path denied" ? allowed : workspaceDir],
        continueOnPrepareError: true,
        onPrepareError: (error) => errors.push(error),
      });
      expect(blocks).toMatchObject([
        { type: "attachment_error", attachment: { code: "delivery-failed" } },
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).not.toContain(state.root);
      expect(await listManagedImageRecordEntries({ stateDir })).toEqual([]);
      expect(await fs.readFile(source)).toEqual(bytes);
    }),
);
