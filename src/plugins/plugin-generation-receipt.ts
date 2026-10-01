import { createHash, type Hash } from "node:crypto";
import { hashPluginSourceFile } from "./plugin-source-file.js";

type PluginSourceContent = { contentHash: string; sizeBytes: number };
type PluginGenerationReceipt = { signature: string; sourceDigest: string };
type PluginReceiptFile = {
  target: string;
  boundary: string;
  sizeBytes: number;
  native: boolean;
  onContent: (fact: PluginSourceContent) => void;
  content?: PluginSourceContent;
};

/** Reuse the initial raw-byte receipt only when its complete ordered inputs still match. */
export function createPluginGenerationReceipt(prepared?: PluginGenerationReceipt) {
  const events: Array<string | PluginReceiptFile> = [];
  let finished: PluginGenerationReceipt | undefined;
  const publishContent = (file: PluginReceiptFile, content: PluginSourceContent) => {
    if (content.sizeBytes !== file.sizeBytes) {
      throw new Error(
        "Plugin source changed while preparing its reload; retry after the edit finishes.",
      );
    }
    if (!file.content) {
      file.content = content;
      file.onContent(content);
    }
  };
  const readContent = (file: PluginReceiptFile, receipt?: Hash) => {
    const content = hashPluginSourceFile(file.target, file.boundary, receipt, file.content);
    publishContent(file, content);
  };
  const inputSignature = () => {
    if (events.some((event) => typeof event !== "string" && !event.content)) {
      return undefined;
    }
    const signature = createHash("sha256");
    for (const event of events) {
      signature.update(
        JSON.stringify(
          typeof event === "string"
            ? ["marker", event]
            : ["file", event.sizeBytes, event.content!.contentHash],
        ),
      );
    }
    return signature.digest("hex");
  };
  return {
    marker(framed: string): void {
      if (!finished) {
        events.push(framed);
      }
    },
    file(params: Omit<PluginReceiptFile, "content"> & { prepared?: PluginSourceContent }): void {
      const { prepared: content, ...input } = params;
      const file: PluginReceiptFile = input;
      if (file.native && content) {
        publishContent(file, content);
      } else if (!file.native || finished) {
        readContent(file);
      }
      if (!finished) {
        events.push(file);
      }
    },
    finish(): PluginGenerationReceipt {
      if (finished) {
        return finished;
      }
      const signature = inputSignature();
      const receipt =
        signature !== undefined && prepared?.signature === signature
          ? undefined
          : createHash("sha256");
      for (const event of events) {
        if (typeof event === "string") {
          receipt?.update(event);
        } else if (receipt || !event.content) {
          // The legacy receipt includes raw bytes; a miss must replay even known native digests.
          readContent(event, receipt);
        }
      }
      finished = {
        signature: signature ?? inputSignature()!,
        sourceDigest: receipt ? receipt.digest("hex") : prepared!.sourceDigest,
      };
      events.length = 0;
      return finished;
    },
  };
}
