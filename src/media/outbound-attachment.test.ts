import fs from "node:fs/promises";
import path from "node:path";
import { aroundEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  resolveOutboundAttachmentFromBuffer,
  resolveOutboundAttachmentFromUrl,
} from "./outbound-attachment.js";
import * as webMedia from "./web-media.js";

let state: OpenClawTestState;
aroundEach((runTest) =>
  withOpenClawTestState({ layout: "state-only", label: "outbound-staging" }, async (current) => {
    state = current;
    await fs.mkdir(state.statePath("media", "outbound"), { recursive: true });
    await runTest();
  }),
);

it.each(["url", "buffer"])(
  "stages %s bytes with their filename, MIME type, and limit",
  async (kind) => {
    const buffer = Buffer.from("%PDF-1.4\n%%EOF\n");
    const source = await state.writeText("report.pdf", buffer.toString());
    using marker = vi.spyOn(webMedia, "markTrustedGeneratedHtmlPath");
    const stage = (maxBytes: number) =>
      kind === "url"
        ? resolveOutboundAttachmentFromUrl(source, maxBytes, { localRoots: [state.stateDir] })
        : resolveOutboundAttachmentFromBuffer(buffer, maxBytes, {
            contentType: "application/pdf",
            filename: "report.pdf",
          });

    const saved = await stage(1024);
    expect(path.dirname(saved.path)).toBe(state.statePath("media", "outbound"));
    expect(path.basename(saved.path)).toMatch(/^report---[a-f0-9-]{36}\.pdf$/);
    expect(saved.contentType).toBe("application/pdf");
    expect(await fs.readFile(saved.path)).toEqual(buffer);
    await expect(stage(buffer.length - 1)).rejects.toThrow(/exceeds .* limit/);
    expect(marker).not.toHaveBeenCalled();
  },
);

it("removes staged HTML and preserves its source when provenance fails", async ({
  onTestFinished,
}) => {
  const workspace = useAutoCleanupTempDirTracker(onTestFinished).make(
    "outbound-html-",
    resolvePreferredOpenClawTmpDir(),
  );
  const source = path.join(workspace, "report.html");
  const html = Buffer.from("<!doctype html><title>report</title>");
  await fs.writeFile(source, html);
  const failure = new Error("marker write failed");
  using marker = vi
    .spyOn(webMedia, "markTrustedGeneratedHtmlPath")
    .mockImplementationOnce(async (file) => {
      expect(await fs.readFile(file)).toEqual(html);
      throw failure;
    });

  await expect(
    resolveOutboundAttachmentFromUrl(source, 1024, {
      mediaAccess: { localRoots: [workspace], readFile: (file) => fs.readFile(file) },
    }),
  ).rejects.toBe(failure);
  expect(marker).toHaveBeenCalledOnce();
  expect(await fs.readdir(state.statePath("media", "outbound"))).toEqual([]);
  expect(await fs.readFile(source)).toEqual(html);
});

it("rejects revoked buffer publication without removing earlier output", async () => {
  let allowed = true;
  const failure = new Error("publication revoked");
  const stage = () =>
    resolveOutboundAttachmentFromBuffer(Buffer.from("hello"), 1024, {
      contentType: "text/plain",
      filename: "note.txt",
      assertCommitAllowed: () => {
        if (!allowed) {
          throw failure;
        }
      },
    });
  const saved = await stage();
  allowed = false;
  await expect(stage()).rejects.toBe(failure);
  expect(await fs.readdir(state.statePath("media", "outbound"))).toEqual([
    path.basename(saved.path),
  ]);
  expect(await fs.readFile(saved.path, "utf8")).toBe("hello");
});
