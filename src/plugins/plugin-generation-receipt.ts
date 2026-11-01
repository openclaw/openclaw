import { createHash, type Hash } from "node:crypto";
import {
  createRootFileOpenBatchSync,
  type RootFileOpenBatchSync,
} from "@openclaw/fs-safe/advanced";
import { getPluginGenerationMetrics } from "./plugin-generation-metrics.js";
import { hashPluginSourceFile } from "./plugin-source-file.js";
import type { PluginCapturedSourceFact as PluginSourceContent } from "./plugin-source-verification.js";

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
  const readContent = (
    file: PluginReceiptFile,
    receipt?: Hash,
    expected = file.content,
    openFile?: RootFileOpenBatchSync["openFile"],
  ) => {
    const content = hashPluginSourceFile(
      file.target,
      file.boundary,
      receipt,
      file.native ? file.content : undefined,
      openFile,
    );
    if (!file.native && expected && content.contentHash !== expected.contentHash) {
      throw new Error(
        "Plugin source changed while preparing its reload; retry after the edit finishes.",
      );
    }
    const metrics = getPluginGenerationMetrics();
    if (metrics) {
      metrics.receiptFileReads++;
      metrics.receiptReadBytes += content.sizeBytes;
    }
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
    file(
      params: Omit<PluginReceiptFile, "content"> & { prepared?: PluginSourceContent },
      openFile?: RootFileOpenBatchSync["openFile"],
    ): void {
      const { prepared: content, ...input } = params;
      const file: PluginReceiptFile = input;
      if (content) {
        if (finished && !file.native) {
          readContent(file, undefined, content, openFile);
        } else {
          publishContent(file, content);
        }
      } else if (!file.native || finished) {
        readContent(file, undefined, undefined, openFile);
      }
      if (!finished) {
        events.push(file);
      }
    },
    finish(): PluginGenerationReceipt {
      if (finished) {
        return finished;
      }
      const metrics = getPluginGenerationMetrics();
      if (metrics) {
        metrics.receiptPasses++;
      }
      const signature = inputSignature();
      const receipt =
        signature !== undefined && prepared?.signature === signature
          ? undefined
          : createHash("sha256");
      using opened = createRootFileOpenBatchSync();
      const openFile = opened.openFile.bind(opened);
      for (const event of events) {
        if (typeof event === "string") {
          receipt?.update(event);
        } else if (receipt || !event.content || !event.native) {
          // Copied descriptors supply bytes, not pathname admission. Recheck ordinary
          // destinations even on a receipt hit; misses also replay native raw bytes.
          readContent(event, receipt, event.content, openFile);
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
