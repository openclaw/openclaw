import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import { expect, it } from "vitest";
import "./stream.js";

it("keeps process-owned providers when a plugin reevaluates the stream facade", async () => {
  const provider = defaultApiRegistry.getApiProvider("openai-chatgpt-responses");
  expect(provider).toBeDefined();

  await import(
    /* @vite-ignore */ new URL("./stream.ts?plugin-runtime-reload", import.meta.url).href
  );

  expect(defaultApiRegistry.getApiProvider("openai-chatgpt-responses")).toBe(provider);
});
