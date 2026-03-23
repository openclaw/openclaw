import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sessionBindingContractChannelIds } from "./manifest.js";

const sessionBindingAdapterFiles = [
  "../../../../extensions/discord/src/monitor/thread-bindings.manager.ts",
  "../../../../extensions/feishu/src/thread-bindings.ts",
  "../../../../extensions/matrix/src/matrix/thread-bindings.ts",
  "../../../../extensions/telegram/src/thread-bindings.ts",
] as const;

function discoverSessionBindingChannels() {
  const channels = new Set<string>();
  for (const relativePath of sessionBindingAdapterFiles) {
    const filePath = path.resolve(import.meta.dirname, relativePath);
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(
      /registerSessionBindingAdapter\(\{[\s\S]*?channel:\s*"([^"]+)"/g,
    )) {
      channels.add(match[1]);
    }
  }
  return [...channels].toSorted();
}

describe("channel contract registry", () => {
  it("keeps session binding coverage aligned with registered session binding adapters", () => {
    expect([...sessionBindingContractChannelIds]).toEqual(discoverSessionBindingChannels());
  });
});
