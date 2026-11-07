import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withChannelReadAuthority } from "../shared/channel-read-authority.js";
import { installMediaFetchTestHooks, saveResponseMedia, tempHome } from "./fetch.test-support.js";

describe("saveResponseMedia authority", () => {
  installMediaFetchTestHooks();

  it.each(["allowed", "caller", "ambient", "abort"] as const)(
    "keeps saved-response publication bound to live authority (%s)",
    async (outcome) => {
      const subdir = "saved-response-" + outcome;
      const mediaDir = path.join(tempHome.home, ".openclaw", "media", subdir);
      const prefix = Buffer.from("%PDF-1.4\n");
      const suffix = Buffer.from("%%EOF\n");
      const closed = new Error("saved-response " + outcome + " revoked");
      const parent = new AbortController();
      let callerAllowed = true;
      let ambientAllowed = true;
      let pulls = 0;
      let partialBytes: Buffer | undefined;
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(prefix);
              return;
            }
            const partialFiles = await fs.readdir(mediaDir);
            expect(partialFiles).toHaveLength(1);
            const partialFile = partialFiles[0];
            if (!partialFile) {
              throw new Error("missing partially written media");
            }
            partialBytes = await fs.readFile(path.join(mediaDir, partialFile));
            if (outcome === "caller") {
              callerAllowed = false;
            }
            if (outcome === "ambient") {
              ambientAllowed = false;
            }
            if (outcome === "abort") {
              parent.abort(closed);
            }
            controller.enqueue(suffix);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const save = () =>
        saveResponseMedia(new Response(body, { headers: { "Content-Type": "application/pdf" } }), {
          sourceUrl: "https://files.example.test/ingress.pdf",
          originalFilename: "proof.pdf",
          subdir,
          maxBytes: 1024,
          assertCurrent: () => {
            if (!callerAllowed) {
              throw closed;
            }
          },
        });
      const operation =
        outcome === "ambient" || outcome === "abort"
          ? withChannelReadAuthority(
              () => {
                if (!ambientAllowed) {
                  throw closed;
                }
              },
              save,
              parent.signal,
            )
          : save();
      if (outcome === "allowed") {
        const saved = await operation;
        expect(saved.contentType).toBe("application/pdf");
        await expect(fs.readFile(saved.path)).resolves.toEqual(Buffer.concat([prefix, suffix]));
        expect(await fs.readdir(mediaDir)).toEqual([path.basename(saved.path)]);
      } else {
        await expect(operation).rejects.toBe(closed);
        expect(await fs.readdir(mediaDir)).toEqual([]);
      }
      expect(partialBytes).toEqual(prefix);
      expect(pulls).toBe(2);
      expect(body.locked).toBe(false);
    },
  );
});
